// ─────────────────────────────────────────────────────────────
// Flint · Stateless Sandbox Mesh — infinitely scalable agent
// compute across free cloud providers.
//
// Research-grounded design (2026 landscape):
//   • Cloudflare Sandboxes: agent containers live on Durable
//     Objects; state must outlive compute.
//   • E2B / Firecracker: pause/resume snapshots, per-second
//     billing, $100 free credits, 20 concurrent Hobby sandboxes.
//   • Daytona: 90ms boots, snapshot restore, free tier.
//   • InstaBox (instabox.sh): 5 free full VMs (4 vCPU / 8 GiB),
//     ~1s pause/resume, snapshots, exec + desktop APIs.
//   • GitHub Actions: unlimited free compute on public repos —
//     workflow_dispatch-driven batch execution.
//   • Jupyter kernels: any token-authed Jupyter endpoint is an
//     execution sandbox (self-hosted, Binder, HF Spaces).
//   • Docker / local processes: free self-hosted capacity.
//
// The stateless protocol (the core insight):
//     snapshot-in ──▶ [ acquire sandbox · restore files · exec ·
//                      capture artifacts · snapshot-out ] ──▶ recycle
//   Sandboxes are cattle. State lives in DurableSnapshots keyed
//   by durable actors. Any provider can run any task; a dead
//   provider just means failover to the next one. That is what
//   makes the mesh horizontally unbounded.
//
// Scheduling: capability match → free-first cost tiers → health
// score (inflight, latency, failure streak) with circuit breakers
// (3 consecutive failures → 60s cooldown).
// ─────────────────────────────────────────────────────────────
import { spawn } from 'child_process'
import fsp from 'fs/promises'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { Semaphore, sleep } from './concurrency'
import { bus } from './events'
import { durable, DurableObjectBase } from './durable'

// ── types ────────────────────────────────────────────────────

export type SandboxCap = 'exec' | 'files' | 'pause' | 'snapshot' | 'desktop' | 'python' | 'node' | 'batch'
export type CostTier = 'free' | 'credits' | 'paid'

export interface MeshTaskSpec {
  command: string
  language?: 'bash' | 'python' | 'node'
  cwd?: string
  env?: Record<string, string>
  files?: Record<string, string>
  timeoutMs?: number
  captureGlobs?: string[]
  snapshotIn?: string // DurableSnapshot ref (fs bundle) restored before exec
  makeSnapshotOut?: boolean
  provider?: string // pin provider, else scheduler picks
  label?: string
}

export interface MeshTaskResult {
  taskId: string
  provider: string
  sandboxId: string | null
  exitCode: number | null
  stdout: string
  stderr: string
  artifacts: Record<string, string>
  snapshotOut?: string
  durationMs: number
  costUsd: number
  attempts: Array<{ provider: string; ok: boolean; error?: string; durationMs: number }>
}

export interface ProviderHandle {
  dbId: string
  externalId?: string
  workspace: string
  meta: Record<string, unknown>
  /** provider-specific client object (SDK sandbox etc.) */
  client?: unknown
}

export interface ProviderInfo {
  id: string
  configured: boolean
  status: 'healthy' | 'degraded' | 'cooldown' | 'unconfigured'
  caps: SandboxCap[]
  costTier: CostTier
  costPerHourUsd: number
  maxConcurrent: number
  inflight: number
  totalTasks: number
  failedTasks: number
  consecutiveFailures: number
  cooldownRemainingMs: number
  lastError?: string
  lastSuccessAt?: number | null
  detail: string
}

export interface ExecOutcome { exitCode: number | null; stdout: string; stderr: string }

// ── provider base ────────────────────────────────────────────

const CAPTURE_FILE_LIMIT = 32
const CAPTURE_FILE_MAX_BYTES = 512 * 1024
const BUNDLE_MAX_BYTES = 8 * 1024 * 1024
const CIRCUIT_FAILURES = 3
const CIRCUIT_COOLDOWN_MS = 60_000

export abstract class MeshProviderBase {
  abstract readonly id: string
  abstract readonly caps: SandboxCap[]
  abstract readonly costTier: CostTier
  abstract readonly costPerHourUsd: number
  readonly maxConcurrent: number
  readonly sem: Semaphore
  inflight = 0
  totalTasks = 0
  failedTasks = 0
  consecutiveFailures = 0
  cooldownUntil = 0
  lastError?: string
  lastSuccessAt?: number | null = null
  avgLatencyMs = 1_000

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent
    this.sem = new Semaphore(maxConcurrent)
  }

  abstract isConfigured(): boolean
  abstract detail(): string
  abstract acquire(spec: MeshTaskSpec): Promise<ProviderHandle>
  abstract exec(h: ProviderHandle, spec: MeshTaskSpec): Promise<ExecOutcome>
  abstract writeFile(h: ProviderHandle, relPath: string, content: string): Promise<void>
  abstract readFile(h: ProviderHandle, relPath: string): Promise<string | null>
  abstract release(h: ProviderHandle, opts: { destroy?: boolean }): Promise<void>

  cooling(): boolean { return Date.now() < this.cooldownUntil }
  cooldownRemainingMs(): number { return Math.max(0, this.cooldownUntil - Date.now()) }

  noteSuccess(durationMs: number): void {
    this.lastSuccessAt = Date.now()
    this.consecutiveFailures = 0
    this.totalTasks++
    this.avgLatencyMs = Math.round(this.avgLatencyMs * 0.7 + durationMs * 0.3)
  }
  noteFailure(err: string): void {
    this.failedTasks++
    this.totalTasks++
    this.consecutiveFailures++
    this.lastError = err.slice(0, 300)
    if (this.consecutiveFailures >= CIRCUIT_FAILURES) {
      this.cooldownUntil = Date.now() + CIRCUIT_COOLDOWN_MS
      this.consecutiveFailures = 0
      bus.emit({
        type: 'mesh:provider', level: 'warn', source: 'sandbox',
        message: `provider ${this.id} circuit opened — 60s cooldown (${err.slice(0, 120)})`,
        data: { provider: this.id },
      })
    }
  }

  score(): number {
    // lower = better: prefer free, idle, fast, proven providers
    const tierWeight = this.costTier === 'free' ? 0 : this.costTier === 'credits' ? 40 : 100
    return tierWeight + this.inflight * 25 + this.avgLatencyMs / 1000 + (this.lastSuccessAt ? 0 : 10)
  }

  info(): ProviderInfo {
    const configured = this.isConfigured()
    return {
      id: this.id,
      configured,
      status: !configured ? 'unconfigured' : this.cooling() ? 'cooldown' : this.consecutiveFailures > 0 ? 'degraded' : 'healthy',
      caps: this.caps,
      costTier: this.costTier,
      costPerHourUsd: this.costPerHourUsd,
      maxConcurrent: this.maxConcurrent,
      inflight: this.inflight,
      totalTasks: this.totalTasks,
      failedTasks: this.failedTasks,
      consecutiveFailures: this.consecutiveFailures,
      cooldownRemainingMs: this.cooldownRemainingMs(),
      lastError: this.lastError,
      lastSuccessAt: this.lastSuccessAt,
      detail: this.detail(),
    }
  }
}

// ── shell helper (local/docker) ──────────────────────────────

function sh(cmd: string, args: string[], timeoutMs = 60_000, env?: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { timeout: timeoutMs, ...(env ? { env: { ...process.env, ...env } } : {}) })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => { stdout += d.toString(); if (stdout.length > 2_000_000) p.kill() })
    p.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 500_000) p.kill() })
    p.on('error', (e) => resolve({ code: 127, stdout, stderr: stderr + String(e) }))
    p.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

// ── provider: local process (always free) ────────────────────

const LOCAL_MESH_DIR = path.join(process.cwd(), 'sandboxes', 'mesh')

export class LocalProcessProvider extends MeshProviderBase {
  readonly id = 'local'
  readonly caps: SandboxCap[] = ['exec', 'files', 'python', 'node']
  readonly costTier: CostTier = 'free'
  readonly costPerHourUsd = 0
  private dockerAvailable: boolean | null = null

  constructor(maxConcurrent = 8) { super(maxConcurrent) }

  isConfigured(): boolean { return true }
  detail(): string { return 'self-hosted local processes (bash/python/node) — always free, zero egress' }

  private async workspaceFor(dbId: string): Promise<string> {
    const dir = path.join(LOCAL_MESH_DIR, 'local', dbId)
    await fsp.mkdir(dir, { recursive: true })
    return dir
  }

  async acquire(spec: MeshTaskSpec): Promise<ProviderHandle> {
    const { db } = await import('@/lib/db')
    const row = await db.meshSandbox.create({
      data: { provider: 'local', status: 'busy', spec: JSON.stringify({ language: spec.language ?? 'bash' }), costPerHourUsd: 0 },
    })
    const workspace = await this.workspaceFor(row.id)
    return { dbId: row.id, workspace, meta: {} }
  }

  async exec(h: ProviderHandle, spec: MeshTaskSpec): Promise<ExecOutcome> {
    const env: Record<string, string> = { ...spec.env, FLINT_MESH: '1' }
    const lang = spec.language ?? 'bash'
    const cd = `cd ${JSON.stringify(h.workspace)} && `
    const body = lang === 'python'
      ? `python3 -c ${JSON.stringify(spec.command)}`
      : lang === 'node'
        ? `node -e ${JSON.stringify(spec.command)}`
        : `(${spec.command})`
    const res = await sh('bash', ['-c', cd + body], spec.timeoutMs ?? 120_000, env)
    return { exitCode: res.code, stdout: res.stdout, stderr: res.stderr }
  }

  async writeFile(h: ProviderHandle, relPath: string, content: string): Promise<void> {
    const abs = path.join(h.workspace, relPath)
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    await fsp.writeFile(abs, content)
  }
  async readFile(h: ProviderHandle, relPath: string): Promise<string | null> {
    try { return await fsp.readFile(path.join(h.workspace, relPath), 'utf8') } catch { return null }
  }

  async release(h: ProviderHandle, opts: { destroy?: boolean }): Promise<void> {
    const { db } = await import('@/lib/db')
    await fsp.rm(h.workspace, { recursive: true, force: true }).catch(() => {})
    await db.meshSandbox.update({
      where: { id: h.dbId },
      data: { status: 'recycled', recycledAt: new Date(), lastHeartbeat: new Date() },
    }).catch(() => {})
  }
}

// ── provider: docker (self-hosted, free) ─────────────────────

export class DockerProvider extends MeshProviderBase {
  readonly id = 'docker'
  readonly caps: SandboxCap[] = ['exec', 'files', 'python', 'node', 'snapshot']
  readonly costTier: CostTier = 'free'
  readonly costPerHourUsd = 0
  private dockerAvailable: boolean | null = null
  private lastProbe = 0

  constructor(maxConcurrent = 4) { super(maxConcurrent) }

  isConfigured(): boolean { return true }
  detail(): string { return 'self-hosted Docker containers (isolated workspaces per task) — free' }

  private async probe(): Promise<boolean> {
    if (this.dockerAvailable !== null && Date.now() - this.lastProbe < 60_000) return this.dockerAvailable
    const res = await sh('docker', ['info', '--format', '{{.ServerVersion}}'], 8_000)
    this.dockerAvailable = res.code === 0
    this.lastProbe = Date.now()
    return this.dockerAvailable
  }

  async acquire(spec: MeshTaskSpec): Promise<ProviderHandle> {
    if (!(await this.probe())) throw new Error('docker daemon not reachable')
    const { db } = await import('@/lib/db')
    const image = (spec.env?.MESH_IMAGE as string) || 'python:3.12-slim'
    const name = 'flint-mesh-' + crypto.randomBytes(5).toString('hex')
    const res = await sh('docker', [
      'run', '-d', '--rm', '--name', name, '--network', 'bridge',
      '--memory', '1g', '--cpus', '1.5',
      '-w', '/workspace',
      image, 'sh', '-c', 'sleep infinity',
    ], 60_000)
    if (res.code !== 0) throw new Error(`docker run failed: ${res.stderr.slice(0, 200)}`)
    const row = await db.meshSandbox.create({
      data: { provider: 'docker', externalId: name, status: 'busy', spec: JSON.stringify({ image }), costPerHourUsd: 0 },
    })
    return { dbId: row.id, externalId: name, workspace: '/workspace', meta: { image } }
  }

  async exec(h: ProviderHandle, spec: MeshTaskSpec): Promise<ExecOutcome> {
    const name = h.externalId!
    const lang = spec.language ?? 'bash'
    const arg = lang === 'python' ? `python3 -c ${JSON.stringify(spec.command)}` : lang === 'node' ? `node -e ${JSON.stringify(spec.command)}` : spec.command
    const res = await sh('docker', ['exec', '-w', '/workspace', name, 'sh', '-c', arg], spec.timeoutMs ?? 120_000)
    return { exitCode: res.code, stdout: res.stdout, stderr: res.stderr }
  }

  async writeFile(h: ProviderHandle, relPath: string, content: string): Promise<void> {
    // write via stdin heredoc to avoid docker cp staging dirs
    const dir = path.dirname(relPath)
    const quoted = JSON.stringify(content)
    await sh('docker', ['exec', '-w', '/workspace', h.externalId!, 'sh', '-c',
      `mkdir -p ${JSON.stringify(dir)} && printf %s ${quoted} > ${JSON.stringify(relPath)}`], 30_000)
  }
  async readFile(h: ProviderHandle, relPath: string): Promise<string | null> {
    const res = await sh('docker', ['exec', '-w', '/workspace', h.externalId!, 'sh', '-c', `cat ${JSON.stringify(relPath)} 2>/dev/null || true`], 30_000)
    return res.code === 0 ? res.stdout : null
  }

  async release(h: ProviderHandle, opts: { destroy?: boolean }): Promise<void> {
    const { db } = await import('@/lib/db')
    if (h.externalId) await sh('docker', ['rm', '-f', h.externalId], 15_000)
    await db.meshSandbox.update({
      where: { id: h.dbId },
      data: { status: 'recycled', recycledAt: new Date(), lastHeartbeat: new Date() },
    }).catch(() => {})
  }
}

// ── provider: InstaBox (instabox.sh — 5 free VMs, 4vCPU/8GiB) ──

export class InstaBoxProvider extends MeshProviderBase {
  readonly id = 'instabox'
  readonly caps: SandboxCap[] = ['exec', 'files', 'pause', 'snapshot', 'desktop']
  readonly costTier: CostTier = 'free'
  readonly costPerHourUsd = 0 // free tier: 5 machines, 4 vCPU / 8 GiB each
  private sdk: any = null
  private sdkLoaded = false

  constructor(maxConcurrent = 5) { super(maxConcurrent) }

  isConfigured(): boolean { return !!process.env.INSTABOX_API_KEY }
  detail(): string {
    return this.isConfigured()
      ? 'instabox.sh full Linux VMs — 5 free machines (4 vCPU/8 GiB), pause/resume, snapshots, desktop'
      : 'instabox.sh — set INSTABOX_API_KEY (ibk_…) — 5 free machines'
  }

  private async loadSdk(): Promise<any> {
    if (this.sdkLoaded) return this.sdk
    this.sdkLoaded = true
    try {
      this.sdk = await import('@insforge/instabox-sdk')
    } catch { this.sdk = null }
    return this.sdk
  }

  async acquire(spec: MeshTaskSpec): Promise<ProviderHandle> {
    const mod = await this.loadSdk()
    if (!mod) throw new Error('@insforge/instabox-sdk not installed')
    const sbx = await mod.Sandbox.create('universal', {
      apiKey: process.env.INSTABOX_API_KEY,
      metadata: { flint: spec.label ?? 'mesh' },
    })
    const { db } = await import('@/lib/db')
    const row = await db.meshSandbox.create({
      data: { provider: 'instabox', externalId: sbx.sandboxId, status: 'busy', spec: JSON.stringify({ template: 'universal' }), costPerHourUsd: 0 },
    })
    return { dbId: row.id, externalId: sbx.sandboxId, workspace: '/data/home', meta: {}, client: sbx }
  }

  async exec(h: ProviderHandle, spec: MeshTaskSpec): Promise<ExecOutcome> {
    const sbx = h.client as any
    try {
      const r = await sbx.commands.run(spec.command, { cwd: spec.cwd ?? '/data/home', timeoutMs: spec.timeoutMs ?? 120_000 })
      return { exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; exitCode?: number; timedOut?: boolean }
      if (typeof e.exitCode === 'number') return { exitCode: e.exitCode, stdout: e.stdout ?? '', stderr: e.stderr ?? String(err) }
      throw err
    }
  }

  async writeFile(h: ProviderHandle, relPath: string, content: string): Promise<void> {
    await (h.client as any).files.write(path.posix.join(h.workspace, relPath), content)
  }
  async readFile(h: ProviderHandle, relPath: string): Promise<string | null> {
    try { return await (h.client as any).files.read(path.posix.join(h.workspace, relPath)) } catch { return null }
  }

  async release(h: ProviderHandle, opts: { destroy?: boolean }): Promise<void> {
    const { db } = await import('@/lib/db')
    try { await (h.client as any).kill?.() ?? true } catch { /* already gone */ }
    try {
      const mod = await this.loadSdk()
      if (mod) await mod.Sandbox.kill(h.externalId!).catch(() => {})
    } catch { /* best effort */ }
    await db.meshSandbox.update({
      where: { id: h.dbId },
      data: { status: 'recycled', recycledAt: new Date(), lastHeartbeat: new Date() },
    }).catch(() => {})
  }
}

// ── provider: E2B (Firecracker microVMs, $100 free credits) ──

export class E2BProvider extends MeshProviderBase {
  readonly id = 'e2b'
  readonly caps: SandboxCap[] = ['exec', 'files', 'pause', 'snapshot']
  readonly costTier: CostTier = 'credits' // Hobby: $100 one-time credits, 20 concurrent, 1h sessions
  readonly costPerHourUsd = 0.17 // 2vCPU/4GiB nominal — covered by free credits first
  private sdk: any = null
  private sdkLoaded = false

  constructor(maxConcurrent = 6) { super(maxConcurrent) }

  isConfigured(): boolean { return !!process.env.E2B_API_KEY }
  detail(): string {
    return this.isConfigured()
      ? 'E2B Firecracker microVMs — $100 free credits, pause/resume with memory+filesystem'
      : 'E2B — set E2B_API_KEY — $100 free credits'
  }

  private async loadSdk(): Promise<any> {
    if (this.sdkLoaded) return this.sdk
    this.sdkLoaded = true
    try { this.sdk = await import('e2b') } catch { this.sdk = null }
    return this.sdk
  }

  async acquire(spec: MeshTaskSpec): Promise<ProviderHandle> {
    const mod = await this.loadSdk()
    if (!mod) throw new Error('e2b package not installed')
    const sbx = await mod.Sandbox.create({ timeoutMs: Math.min(spec.timeoutMs ?? 300_000, 3_600_000) })
    const { db } = await import('@/lib/db')
    const row = await db.meshSandbox.create({
      data: { provider: 'e2b', externalId: sbx.sandboxId, status: 'busy', spec: JSON.stringify({ template: 'base' }), costPerHourUsd: this.costPerHourUsd },
    })
    return { dbId: row.id, externalId: sbx.sandboxId, workspace: '/home/user', meta: {}, client: sbx }
  }

  async exec(h: ProviderHandle, spec: MeshTaskSpec): Promise<ExecOutcome> {
    const r = await (h.client as any).commands.run(spec.command, {
      timeoutMs: spec.timeoutMs ?? 120_000,
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
    })
    return { exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }
  async writeFile(h: ProviderHandle, relPath: string, content: string): Promise<void> {
    await (h.client as any).files.write(path.posix.join(h.workspace, relPath), content)
  }
  async readFile(h: ProviderHandle, relPath: string): Promise<string | null> {
    try { return await (h.client as any).files.read(path.posix.join(h.workspace, relPath)) } catch { return null }
  }
  async release(h: ProviderHandle, opts: { destroy?: boolean }): Promise<void> {
    const { db } = await import('@/lib/db')
    try { await (h.client as any).kill?.() } catch { /* best effort */ }
    await db.meshSandbox.update({
      where: { id: h.dbId },
      data: { status: 'recycled', recycledAt: new Date(), lastHeartbeat: new Date() },
    }).catch(() => {})
  }
}

// ── provider: Daytona (90ms boots, snapshots, free tier) ─────

export class DaytonaProvider extends MeshProviderBase {
  readonly id = 'daytona'
  readonly caps: SandboxCap[] = ['exec', 'files', 'pause', 'snapshot']
  readonly costTier: CostTier = 'credits'
  readonly costPerHourUsd = 0.15
  private client: any = null
  private clientLoaded = false

  constructor(maxConcurrent = 4) { super(maxConcurrent) }

  isConfigured(): boolean { return !!process.env.DAYTONA_API_KEY }
  detail(): string {
    return this.isConfigured()
      ? 'Daytona sandboxes — 90ms boots, snapshot restore, process+fs APIs'
      : 'Daytona — set DAYTONA_API_KEY (cloud or self-hosted via DAYTONA_SERVER_URL)'
  }

  private async getClient(): Promise<any> {
    if (this.clientLoaded) return this.client
    this.clientLoaded = true
    try {
      const mod: any = await import('@daytonaio/sdk')
      const Daytona = mod.Daytona ?? mod.default?.Daytona
      this.client = new Daytona({
        apiKey: process.env.DAYTONA_API_KEY,
        ...(process.env.DAYTONA_SERVER_URL ? { apiUrl: process.env.DAYTONA_SERVER_URL } : {}),
      })
    } catch { this.client = null }
    return this.client
  }

  async acquire(spec: MeshTaskSpec): Promise<ProviderHandle> {
    const daytona = await this.getClient()
    if (!daytona) throw new Error('@daytonaio/sdk not available')
    const sbx = await daytona.create({ language: spec.language === 'python' ? 'python' : undefined })
    const { db } = await import('@/lib/db')
    const row = await db.meshSandbox.create({
      data: { provider: 'daytona', externalId: sbx.id, status: 'busy', spec: JSON.stringify({}), costPerHourUsd: this.costPerHourUsd },
    })
    return { dbId: row.id, externalId: sbx.id, workspace: '/workspace', meta: {}, client: sbx }
  }

  async exec(h: ProviderHandle, spec: MeshTaskSpec): Promise<ExecOutcome> {
    const sbx = h.client as any
    const res = await sbx.process.executeCommand(
      spec.command, spec.cwd ?? '/workspace', spec.env ?? {}, Math.ceil((spec.timeoutMs ?? 120_000) / 1000)
    )
    return { exitCode: res.exitCode, stdout: res.result ?? '', stderr: (res as { stderr?: string }).stderr ?? '' }
  }
  async writeFile(h: ProviderHandle, relPath: string, content: string): Promise<void> {
    const sbx = h.client as any
    try {
      await sbx.fs.uploadFile({ source: Buffer.from(content, 'utf8'), remotePath: path.posix.join('/workspace', relPath) })
    } catch {
      // heredoc fallback via exec
      await sbx.process.executeCommand(`cat > ${JSON.stringify(path.posix.join('/workspace', relPath))} <<'FLINTEOF'\n${content}\nFLINTEOF`)
    }
  }
  async readFile(h: ProviderHandle, relPath: string): Promise<string | null> {
    const sbx = h.client as any
    try {
      const buf = await sbx.fs.downloadFile(path.posix.join('/workspace', relPath))
      return Buffer.from(buf).toString('utf8')
    } catch { return null }
  }
  async release(h: ProviderHandle, opts: { destroy?: boolean }): Promise<void> {
    const { db } = await import('@/lib/db')
    try { await (h.client as any).stop?.() } catch { /* best effort */ }
    try {
      const daytona = await this.getClient()
      if (daytona && h.externalId) await daytona.remove({ id: h.externalId }).catch(() => {})
    } catch { /* best effort */ }
    await db.meshSandbox.update({
      where: { id: h.dbId },
      data: { status: 'recycled', recycledAt: new Date(), lastHeartbeat: new Date() },
    }).catch(() => {})
  }
}

// ── provider: GitHub Actions (unlimited free on public repos) ──

export class GitHubActionsProvider extends MeshProviderBase {
  readonly id = 'github-actions'
  readonly caps: SandboxCap[] = ['exec', 'files', 'batch']
  readonly costTier: CostTier = 'free'
  readonly costPerHourUsd = 0
  private token: string | null = null
  private repo: string | null = null

  constructor(maxConcurrent = 5) { super(maxConcurrent) }

  isConfigured(): boolean {
    this.token = process.env.FLINT_GH_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null
    this.repo = process.env.FLINT_GH_REPO || null
    return !!(this.token && this.repo)
  }
  detail(): string {
    return this.isConfigured()
      ? `GitHub Actions compute — free unlimited on public repos (${this.repo}) — batch tier, minutes of latency`
      : 'GitHub Actions — set FLINT_GH_TOKEN + FLINT_GH_REPO (free unlimited on public repos)'
  }

  private gh(apiPath: string, init?: RequestInit): Promise<Response> {
    return fetch(`https://api.github.com${apiPath}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'content-type': 'application/json',
        'user-agent': 'flint-mesh',
        ...(init?.headers as Record<string, string> | undefined),
      },
    })
  }

  async acquire(spec: MeshTaskSpec): Promise<ProviderHandle> {
    if (!this.isConfigured()) throw new Error('github-actions not configured')
    const { db } = await import('@/lib/db')
    const row = await db.meshSandbox.create({
      data: { provider: 'github-actions', status: 'busy', spec: JSON.stringify({ repo: this.repo }), costPerHourUsd: 0 },
    })
    return { dbId: row.id, workspace: 'workspace', meta: { repo: this.repo } }
  }

  /** Fire a workflow_dispatch and poll for the committed result file. */
  async exec(h: ProviderHandle, spec: MeshTaskSpec): Promise<ExecOutcome> {
    const repo = this.repo!
    const workflow = process.env.FLINT_GH_WORKFLOW || 'flint-mesh.yml'
    const taskId = h.dbId
    const payload = Buffer.from(JSON.stringify({
      command: spec.command,
      language: spec.language ?? 'bash',
      env: spec.env ?? {},
      files: spec.files ?? {},
      captureGlobs: spec.captureGlobs ?? [],
      timeoutS: Math.ceil((spec.timeoutMs ?? 600_000) / 1000),
    }), 'utf8').toString('base64')

    const dispatch = await this.gh(`/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({ ref: process.env.FLINT_GH_REF || 'main', inputs: { task_id: taskId, payload_b64: payload } }),
    })
    if (dispatch.status !== 204) {
      throw new Error(`workflow dispatch failed (${dispatch.status}): ${(await dispatch.text()).slice(0, 200)} — ensure ${workflow} exists in ${repo}`)
    }

    // poll for the result file the workflow commits to mesh-results/<task>.json
    const deadline = Date.now() + Math.min(spec.timeoutMs ?? 900_000, 1_800_000)
    while (Date.now() < deadline) {
      await sleep(8_000)
      const res = await this.gh(`/repos/${repo}/contents/mesh-results/${taskId}.json?ref=${encodeURIComponent(process.env.FLINT_GH_REF || 'main')}`)
      if (res.status === 200) {
        const body = (await res.json()) as { content?: string; encoding?: string }
        const raw = body.encoding === 'base64' ? Buffer.from(body.content ?? '', 'base64').toString('utf8') : body.content ?? '{}'
        const parsed = JSON.parse(raw) as { exitCode: number; stdout: string; stderr: string; artifacts: Record<string, string> }
        // cleanup marker file
        await this.gh(`/repos/${repo}/contents/mesh-results/${taskId}.json`, {
          method: 'DELETE',
          body: JSON.stringify({ message: `flint-mesh: cleanup ${taskId}`, sha: (res.json as unknown as { sha?: string }).sha ?? undefined }),
        }).catch(() => {})
        // stash artifacts into the handle workspace for the mesh capture step
        h.meta.artifacts = parsed.artifacts ?? {}
        return { exitCode: parsed.exitCode, stdout: parsed.stdout, stderr: parsed.stderr }
      }
    }
    throw new Error('github-actions timeout waiting for result file (workflow may have failed — check run logs)')
  }

  async writeFile(): Promise<void> { /* files travel inside the dispatch payload */ }
  async readFile(h: ProviderHandle, relPath: string): Promise<string | null> {
    const artifacts = (h.meta.artifacts ?? {}) as Record<string, string>
    return artifacts[relPath] ?? null
  }
  async release(h: ProviderHandle, opts: { destroy?: boolean }): Promise<void> {
    const { db } = await import('@/lib/db')
    await db.meshSandbox.update({
      where: { id: h.dbId },
      data: { status: 'recycled', recycledAt: new Date(), lastHeartbeat: new Date() },
    }).catch(() => {})
  }
}

// ── provider: Jupyter kernels (any token-authed endpoint) ────

export class JupyterProvider extends MeshProviderBase {
  readonly id = 'jupyter'
  readonly caps: SandboxCap[] = ['exec', 'files', 'python']
  readonly costTier: CostTier = 'free'
  readonly costPerHourUsd = 0

  constructor(maxConcurrent = 4) { super(maxConcurrent) }

  isConfigured(): boolean { return !!(process.env.JUPYTER_URL && process.env.JUPYTER_TOKEN) }
  detail(): string {
    return this.isConfigured()
      ? `Jupyter kernel execution on ${process.env.JUPYTER_URL} (self-hosted / Binder / HF Spaces)`
      : 'Jupyter — set JUPYTER_URL + JUPYTER_TOKEN — turns any Jupyter server into a free sandbox'
  }

  private base(): string { return (process.env.JUPYTER_URL || '').replace(/\/$/, '') }

  async acquire(spec: MeshTaskSpec): Promise<ProviderHandle> {
    const res = await fetch(`${this.base()}/api/kernels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `token ${process.env.JUPYTER_TOKEN}` },
      body: JSON.stringify({ name: 'python3' }),
    })
    if (!res.ok) throw new Error(`jupyter kernel create failed: ${res.status}`)
    const k = (await res.json()) as { id: string }
    const { db } = await import('@/lib/db')
    const row = await db.meshSandbox.create({
      data: { provider: 'jupyter', externalId: k.id, status: 'busy', spec: JSON.stringify({}), costPerHourUsd: 0 },
    })
    return { dbId: row.id, externalId: k.id, workspace: '', meta: {} }
  }

  private wsUrl(kernelId: string): string {
    const base = this.base().replace(/^http/, 'ws')
    return `${base}/api/kernels/${kernelId}/channels?token=${process.env.JUPYTER_TOKEN}`
  }

  /** Minimal Jupyter kernel client: execute code over the WS channels. */
  private async kernelExec(kernelId: string, code: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; ok: boolean }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl(kernelId))
      const msgId = crypto.randomUUID()
      let stdout = ''
      let stderr = ''
      let done = false
      const finish = (ok: boolean) => {
        if (done) return
        done = true
        clearTimeout(guard)
        try { ws.close() } catch { /* noop */ }
        resolve({ stdout, stderr, ok })
      }
      const guard = setTimeout(() => { if (!done) { try { ws.close() } catch {}; reject(new Error('jupyter exec timeout')) } }, timeoutMs)
      ws.onopen = () => {
        const header = { msg_id: msgId, msg_type: 'execute_request', username: 'flint', session: crypto.randomUUID(), version: '5.3' }
        ws.send(JSON.stringify(['shell', header, {}, {}, { code, silent: false, store_history: false }, []]))
      }
      ws.onmessage = (ev: MessageEvent) => {
        try {
          const data = typeof ev.data === 'string' ? JSON.parse(ev.data) : null
          if (!Array.isArray(data)) return
          // frame: [channel, header, parent_header, metadata, content, buffers]
          const header = data[1] as { msg_type: string; msg_id?: string; parent_header?: { msg_id?: string } } | undefined
          const content = data[4] as Record<string, unknown> | undefined
          const parent = (data[2] as { msg_id?: string } | undefined)?.msg_id
          if (parent && parent !== msgId) return
          const t = header?.msg_type
          if (t === 'stream') {
            const s = String(content?.text ?? '')
            if (content?.name === 'stderr') stderr += s
            else stdout += s
          } else if (t === 'error') {
            stderr += ((content?.ename as string) ?? '') + ': ' + ((content?.evalue as string) ?? '') + '\n'
          } else if (t === 'execute_reply') {
            finish(String((content as { status?: string })?.status) === 'ok')
          } else if (t === 'status' && content?.execution_state === 'idle' && stdout.length > 0) {
            // idle after output — allow a grace beat for execute_reply
            setTimeout(() => finish(true), 250)
          }
        } catch { /* ignore malformed frames */ }
      }
      ws.onerror = () => { if (!done) reject(new Error('jupyter websocket error')) }
      ws.onclose = () => { if (!done) finish(stderr ? false : true) }
    })
  }

  async exec(h: ProviderHandle, spec: MeshTaskSpec): Promise<ExecOutcome> {
    const code = [
      `import subprocess, json, os`,
      `env = json.loads(${JSON.stringify(JSON.stringify(spec.env ?? {}))})`,
      `full_env = dict(os.environ); full_env.update(env)`,
      spec.files && Object.keys(spec.files).length
        ? `import base64\n${Object.entries(spec.files).map(([p, c]) =>
            `open(${JSON.stringify(p)}, 'wb').write(base64.b64decode(${JSON.stringify(Buffer.from(c, 'utf8').toString('base64'))}))`).join('\n')}`
        : '',
      `r = subprocess.run(${JSON.stringify(spec.command)}, shell=True, capture_output=True, text=True, timeout=${Math.ceil((spec.timeoutMs ?? 120_000) / 1000)}, env=full_env)`,
      `print('__FLINT_EXIT__' + str(r.returncode))`,
      `print(r.stdout, end='')`,
      `import sys; print(r.stderr, end='', file=sys.stderr)`,
    ].filter(Boolean).join('\n')
    const out = await this.kernelExec(h.externalId!, code, (spec.timeoutMs ?? 120_000) + 15_000)
    const exitMatch = out.stdout.match(/^__FLINT_EXIT__(-?\d+)$/m)
    return {
      exitCode: exitMatch ? parseInt(exitMatch[1], 10) : out.ok ? 0 : 1,
      stdout: out.stdout.replace(/^__FLINT_EXIT__-?\d+\n?/m, ''),
      stderr: out.stderr,
    }
  }

  async writeFile(h: ProviderHandle, relPath: string, content: string): Promise<void> {
    await this.kernelExec(h.externalId!, `import base64\nopen(${JSON.stringify(relPath)}, 'wb').write(base64.b64decode(${JSON.stringify(Buffer.from(content, 'utf8').toString('base64'))}))`, 30_000)
  }
  async readFile(h: ProviderHandle, relPath: string): Promise<string | null> {
    const out = await this.kernelExec(h.externalId!, `import base64\nprint(base64.b64encode(open(${JSON.stringify(relPath)}, 'rb').read()).decode())`, 30_000)
    try { return Buffer.from(out.stdout.trim(), 'base64').toString('utf8') } catch { return null }
  }
  async release(h: ProviderHandle, opts: { destroy?: boolean }): Promise<void> {
    const { db } = await import('@/lib/db')
    await fetch(`${this.base()}/api/kernels/${h.externalId}`, {
      method: 'DELETE',
      headers: { Authorization: `token ${process.env.JUPYTER_TOKEN}` },
    }).catch(() => {})
    await db.meshSandbox.update({
      where: { id: h.dbId },
      data: { status: 'recycled', recycledAt: new Date(), lastHeartbeat: new Date() },
    }).catch(() => {})
  }
}

// ── mesh snapshot store (durable bundle keeper) ──────────────

export class MeshStoreActor extends DurableObjectBase {
  static className = 'MeshStoreActor'
  static rpcMethods = ['saveBundle', 'loadBundle', 'listBundles'] as const

  async saveBundle(bundle: { files: Record<string, string>; meta?: Record<string, unknown> }): Promise<{ ref: string }> {
    const meta = await this.saveSnapshot('mesh', JSON.stringify(bundle), { ...bundle.meta, files: Object.keys(bundle.files).length })
    return { ref: meta.ref }
  }
  async loadBundle(ref?: string): Promise<{ files: Record<string, string>; ref: string } | null> {
    const target = ref
      ? await this.loadSnapshot(ref)
      : await (async () => { const l = await this.latestSnapshot('mesh'); return l ? await this.loadSnapshot(l.ref) : null })()
    if (!target) return null
    try {
      const parsed = JSON.parse(target.blob.toString('utf8')) as { files: Record<string, string> }
      return { files: parsed.files ?? {}, ref: target.meta.ref }
    } catch { return null }
  }
  async listBundles(): Promise<unknown[]> {
    return (await this.listSnapshots('mesh')) as unknown[]
  }
}

function meshStore() {
  return durable.stub<MeshStoreActor>('mesh:store', 'MeshStoreActor')
}

// ── the mesh registry + scheduler ────────────────────────────

export interface RunTaskOpts {
  maxProviderAttempts?: number
  persist?: boolean // default true
}

class MeshRegistry {
  private providers = new Map<string, MeshProviderBase>()
  private booted = false

  boot(): void {
    if (this.booted) return
    this.booted = true
    durable.register(MeshStoreActor)
    this.register(new LocalProcessProvider())
    this.register(new DockerProvider())
    this.register(new InstaBoxProvider())
    this.register(new E2BProvider())
    this.register(new DaytonaProvider())
    this.register(new GitHubActionsProvider())
    this.register(new JupyterProvider())
    console.log(`[flint:mesh] sandbox mesh online — ${this.providers.size} providers registered (free-first routing, circuit breakers, stateless snapshots)`)
    // periodic provider-health mirror to DB (observability)
    setInterval(() => void this.mirrorHealth(), 30_000).unref?.()
  }

  register(p: MeshProviderBase): void { this.providers.set(p.id, p) }
  list(): MeshProviderBase[] { return [...this.providers.values()] }
  get(id: string): MeshProviderBase | undefined { return this.providers.get(id) }

  providerInfos(): ProviderInfo[] { return this.list().map((p) => p.info()) }

  private candidates(spec: MeshTaskSpec): MeshProviderBase[] {
    if (spec.provider) {
      const pinned = this.get(spec.provider)
      return pinned && pinned.isConfigured() && !pinned.cooling() ? [pinned] : []
    }
    return this.list()
      .filter((p) => p.isConfigured() && !p.cooling())
      .sort((a, b) => a.score() - b.score())
  }

  private bundleSizeOk(files: Record<string, string>): boolean {
    return Object.values(files).reduce((n, c) => n + c.length, 0) < BUNDLE_MAX_BYTES
  }

  /**
   * The stateless execution protocol:
   *   restore snapshot-in → materialize files → exec → capture
   *   artifacts → snapshot-out → recycle sandbox.
   * Provider failures fail over to the next candidate.
   */
  async runTask(spec: MeshTaskSpec, opts: RunTaskOpts = {}): Promise<MeshTaskResult> {
    this.boot()
    const { db } = await import('@/lib/db')
    const started = Date.now()
    const task = await db.meshTask.create({
      data: {
        provider: spec.provider ?? '(scheduled)',
        status: 'running',
        spec: JSON.stringify({ ...spec, command: spec.command.slice(0, 4000) }),
        snapshotIn: spec.snapshotIn ?? null,
      },
    })
    bus.emit({
      type: 'mesh:task', source: 'sandbox',
      message: `mesh task ${task.id.slice(-8)} queued — "${(spec.label ?? spec.command).slice(0, 80)}"`,
      refId: task.id,
      data: { taskId: task.id },
    })

    // restore snapshot-in bundle (durable, provider-agnostic)
    let restoreFiles: Record<string, string> = {}
    if (spec.snapshotIn) {
      const bundle = await meshStore().loadBundle(spec.snapshotIn)
      if (bundle) restoreFiles = bundle.files
    }

    const candidates = this.candidates(spec).slice(0, opts.maxProviderAttempts ?? 3)
    const attempts: MeshTaskResult['attempts'] = []
    if (candidates.length === 0) {
      const err = `no healthy provider available${spec.provider ? ` (pinned: ${spec.provider})` : ''} — configure INSTABOX_API_KEY / E2B_API_KEY / DAYTONA_API_KEY / FLINT_GH_TOKEN / JUPYTER_URL or check docker`
      await db.meshTask.update({ where: { id: task.id }, data: { status: 'failed', result: JSON.stringify({ error: err }), attempts: '[]', finishedAt: new Date() } })
      throw new Error(err)
    }

    for (const provider of candidates) {
      const t0 = Date.now()
      let handle: ProviderHandle | null = null
      try {
        provider.inflight++
        await provider.sem.acquire()
        bus.emit({ type: 'mesh:sandbox', source: 'sandbox', message: `provider ${provider.id} acquired for task ${task.id.slice(-8)}`, refId: task.id })
        handle = await provider.acquire(spec)
        await db.meshTask.update({ where: { id: task.id }, data: { sandboxId: handle.dbId, provider: provider.id } })

        // 1. restore snapshot files + 2. spec files
        const allFiles = { ...restoreFiles, ...(spec.files ?? {}) }
        if (Object.keys(allFiles).length) {
          if (!this.bundleSizeOk(allFiles)) throw new Error('file payload exceeds 8 MiB mesh limit')
          for (const [rel, content] of Object.entries(allFiles)) {
            await provider.writeFile(handle, rel, content)
          }
        }

        // 3. execute
        const outcome = await provider.exec(handle, spec)

        // 4. capture artifacts (captureGlobs or produced files)
        const artifacts: Record<string, string> = {}
        const globs = spec.captureGlobs ?? []
        if (globs.length) {
          // `ls` does not expand globs — use find -path (understands patterns,
          // quotes safely, and stays POSIX-portable across all providers)
          const pathTests = globs
            .map((g) => (g.startsWith('./') || g.startsWith('/') ? g.replace(/^\//, './') : './' + g))
            .map((p) => `-path ${JSON.stringify(p)}`)
            .join(' -o ')
          const listingCmd = `find . -maxdepth 4 -type f \\( ${pathTests} \\) 2>/dev/null | sort -u | head -${CAPTURE_FILE_LIMIT}`
          const listing = await provider.exec(handle, {
            ...spec,
            command: listingCmd,
            timeoutMs: 20_000,
          })
          if (process.env.FLINT_DEBUG) {
            console.log(`[flint:mesh] capture listing on ${provider.id} (exit ${listing.exitCode}): ${JSON.stringify(listing.stdout.slice(0, 200))} err=${JSON.stringify(listing.stderr.slice(0, 200))}`)
          }
          for (const f of listing.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
            const rel = f.replace(/^\.\//, '')
            if (Buffer.byteLength(rel) > CAPTURE_FILE_MAX_BYTES) continue
            const content = await provider.readFile(handle, rel)
            if (process.env.FLINT_DEBUG) console.log(`[flint:mesh] read ${rel}: ${content === null ? 'NULL' : content.length + ' bytes'}`)
            if (content !== null) artifacts[rel] = content
          }
        }

        // 5. snapshot-out (workspace bundle)
        let snapshotOut: string | undefined
        if (spec.makeSnapshotOut) {
          const bundleFiles = { ...allFiles, ...artifacts }
          if (this.bundleSizeOk(bundleFiles)) {
            const saved = await meshStore().saveBundle({ files: bundleFiles, meta: { taskId: task.id, provider: provider.id } })
            snapshotOut = saved.ref
          }
        }

        // 6. recycle
        await provider.release(handle, { destroy: true })
        provider.inflight--
        provider.sem.release()
        provider.noteSuccess(Date.now() - t0)

        const durationMs = Date.now() - t0
        const costUsd = (provider.costPerHourUsd * durationMs) / 3_600_000
        attempts.push({ provider: provider.id, ok: true, durationMs })

        const result: MeshTaskResult = {
          taskId: task.id,
          provider: provider.id,
          sandboxId: handle.dbId,
          exitCode: outcome.exitCode,
          stdout: outcome.stdout.slice(0, 200_000),
          stderr: outcome.stderr.slice(0, 50_000),
          artifacts,
          snapshotOut,
          durationMs,
          costUsd,
          attempts,
        }
        await db.meshTask.update({
          where: { id: task.id },
          data: {
            status: 'done',
            provider: provider.id,
            result: JSON.stringify({ exitCode: outcome.exitCode, stdout: result.stdout.slice(0, 4_000), stderr: result.stderr.slice(0, 2_000), artifacts: Object.keys(artifacts), snapshotOut }),
            attempts: JSON.stringify(attempts),
            snapshotOut: snapshotOut ?? null,
            durationMs,
            costUsd,
            finishedAt: new Date(),
          },
        })
        await db.usageEvent.create({
          data: { sandboxId: `mesh:${provider.id}`, kind: 'mesh-exec', seconds: durationMs / 1000, costUsd },
        }).catch(() => {})
        bus.emit({
          type: 'mesh:task', level: 'success', source: 'sandbox',
          message: `mesh task ${task.id.slice(-8)} done on ${provider.id} (${(durationMs / 1000).toFixed(1)}s, exit ${outcome.exitCode}, $${costUsd.toFixed(5)})`,
          refId: task.id,
        })
        return result
      } catch (err) {
        const durationMs = Date.now() - t0
        const msg = err instanceof Error ? err.message : String(err)
        attempts.push({ provider: provider.id, ok: false, error: msg.slice(0, 300), durationMs })
        provider.noteFailure(msg)
        if (handle) await provider.release(handle, { destroy: true }).catch(() => {})
        provider.inflight--
        try { provider.sem.release() } catch { /* already released */ }
        bus.emit({
          type: 'mesh:task', level: 'error', source: 'sandbox',
          message: `mesh task ${task.id.slice(-8)} failed on ${provider.id}: ${msg.slice(0, 120)}${candidates.indexOf(provider) < candidates.length - 1 ? ' — failing over' : ''}`,
          refId: task.id,
        })
        await db.meshTask.update({
          where: { id: task.id },
          data: { attempts: JSON.stringify(attempts), provider: provider.id, status: 'running' },
        }).catch(() => {})
      }
    }

    await db.meshTask.update({
      where: { id: task.id },
      data: { status: 'failed', attempts: JSON.stringify(attempts), result: JSON.stringify({ error: 'all providers failed', attempts }), finishedAt: new Date(), durationMs: Date.now() - started },
    })
    throw new Error(`all mesh providers failed: ${attempts.map((a) => `${a.provider}(${a.error?.slice(0, 80)})`).join('; ')}`)
  }

  private async mirrorHealth(): Promise<void> {
    try {
      const { db } = await import('@/lib/db')
      for (const info of this.providerInfos()) {
        await db.providerHealth.upsert({
          where: { provider: info.id },
          create: {
            provider: info.id, configured: info.configured, status: info.status,
            capabilities: JSON.stringify(info.caps), costTier: info.costTier,
            inflight: info.inflight, totalTasks: info.totalTasks, failedTasks: info.failedTasks,
            consecutiveFailures: info.consecutiveFailures, lastError: info.lastError,
            lastSuccessAt: info.lastSuccessAt ? new Date(info.lastSuccessAt) : null,
          },
          update: {
            configured: info.configured, status: info.status,
            inflight: info.inflight, totalTasks: info.totalTasks, failedTasks: info.failedTasks,
            consecutiveFailures: info.consecutiveFailures, lastError: info.lastError,
            cooldownUntil: info.cooldownRemainingMs > 0 ? new Date(Date.now() + info.cooldownRemainingMs) : null,
            lastSuccessAt: info.lastSuccessAt ? new Date(info.lastSuccessAt) : null,
            lastCheckedAt: new Date(),
          },
        }).catch(() => {})
      }
    } catch { /* mirror best-effort */ }
  }

  async listSandboxes(): Promise<unknown> {
    const { db } = await import('@/lib/db')
    return db.meshSandbox.findMany({ orderBy: { createdAt: 'desc' }, take: 100, include: { tasks: { take: 3, orderBy: { createdAt: 'desc' } } } })
  }

  async listTasks(limit = 50): Promise<unknown> {
    const { db } = await import('@/lib/db')
    return db.meshTask.findMany({ orderBy: { createdAt: 'desc' }, take: Math.min(limit, 200) })
  }
}

const g = globalThis as unknown as { __flintMesh?: MeshRegistry }
export const mesh: MeshRegistry = g.__flintMesh ?? (g.__flintMesh = new MeshRegistry())
export function bootMesh(): void { mesh.boot() }

/** Snapshot helpers shared with RLM host fns. */
export async function saveMeshBundle(files: Record<string, string>, meta?: Record<string, unknown>): Promise<string> {
  mesh.boot()
  const r = await meshStore().saveBundle({ files, meta })
  return r.ref
}
export async function loadMeshBundle(ref?: string): Promise<Record<string, string> | null> {
  mesh.boot()
  const b = await meshStore().loadBundle(ref)
  return b ? b.files : null
}
