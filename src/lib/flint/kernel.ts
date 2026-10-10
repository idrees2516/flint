// ─────────────────────────────────────────────────────────────
// Flint · KernelManager — persistent Python kernels per session.
//
// prime-agent parity:
//   • one long-lived CPython process per agent session
//   • NDJSON protocol (eval / host_call / snapshot / restore)
//   • host bridge: kernel code calls host tools (websearch,
//     spawn, mcp, ...) which block in-kernel until answered
//   • snapshot/restore of the __main__ namespace (per-variable
//     pickling with byte caps — dill-class behavior)
//   • idle eviction: kernels idle > N minutes are snapshotted
//     and killed; next eval lazily restores state (cold-start
//     free resume)
//   • supervised restart with backoff on crash
// ─────────────────────────────────────────────────────────────
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import path from 'path'
import fs from 'fs/promises'
import { Semaphore, sleep } from './concurrency'
import { bus } from './events'

const KERNEL_SCRIPT = path.join(process.cwd(), 'mini-services', 'flint-kernel', 'kernel.py')
const KERNELS_DIR = path.join(process.cwd(), 'sandboxes', '.kernels')

export interface KernelResult {
  ok: boolean
  stdout: string
  stderr: string
  result?: string
  durationMs: number
  restored?: string[]
  error?: string
}

export interface KernelSnapshot {
  blob: string
  manifest: Record<string, { bytes?: number; type?: string; skipped?: boolean; reason?: string }>
}

type HostFn = (sessionId: string, args: unknown[]) => Promise<unknown>

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

interface Kernel {
  sessionId: string
  cwd: string
  proc: ChildProcessWithoutNullStreams | null
  pending: Map<string, Pending> // id → pending reply
  hostCalls: Map<string, { fn: string; args: unknown[] }> // hid → in-flight host call
  hostCallWaiters: Set<() => void> // woken when a host call arrives
  lastActive: number
  startedAt: number
  restarts: number
  snapshot?: KernelSnapshot
  evicted: boolean
  busy: boolean
}

const IDLE_EVICT_MS = 30 * 60 * 1000 // 30 min — prime-agent default
const EVAL_TIMEOUT_MS = 180_000
const MAX_RESTARTS = 5

class KernelManager {
  private kernels = new Map<string, Kernel>()
  private launchSem = new Semaphore(16) // bounded concurrent kernel spawns
  private evictTimer: ReturnType<typeof setInterval> | null = null
  private hostFns = new Map<string, HostFn>()
  running = false

  /** Register a host-callable tool (the RLM tool surface). */
  registerHostFn(name: string, fn: HostFn): void {
    this.hostFns.set(name, fn)
  }

  listHostFns(): string[] {
    return [...this.hostFns.keys()]
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.evictTimer = setInterval(() => this.evictIdle(), 60_000)
    console.log('[flint:kernel] manager online — idle eviction 30m')
  }

  // ── lifecycle ─────────────────────────────────────────────
  private async ensureKernel(sessionId: string, cwd?: string): Promise<Kernel> {
    let k = this.kernels.get(sessionId)
    if (k && !k.evicted && k.proc && !k.proc.killed) return k
    if (!k) {
      k = {
        sessionId,
        cwd: cwd ?? path.join(KERNELS_DIR, sessionId),
        proc: null,
        pending: new Map(),
        hostCalls: new Map(),
        hostCallWaiters: new Set(),
        lastActive: Date.now(),
        startedAt: 0,
        restarts: 0,
        evicted: false,
        busy: false,
      }
      this.kernels.set(sessionId, k)
    }
    if (cwd) k.cwd = cwd
    if (k.proc && !k.proc.killed && !k.evicted) return k
    await this.launchSem.run(async () => {
      await fs.mkdir(k!.cwd, { recursive: true })
      k!.proc = spawn('python3', [KERNEL_SCRIPT], {
        cwd: k!.cwd,
        env: { ...process.env, FLINT_KERNEL_CWD: k!.cwd, PYTHONUNBUFFERED: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams
      k!.startedAt = Date.now()
      k!.evicted = false
      this.wire(k!)
    })
    // lazy resume: restore the last snapshot after eviction/crash/restart
    if (!k.snapshot?.blob) {
      const disk = await this.loadDiskSnapshot(sessionId)
      if (disk?.blob) k.snapshot = disk
    }
    if (k.snapshot?.blob) await this.restoreNow(k, k.snapshot.blob).catch(() => null)
    return k
  }

  private wire(k: Kernel): void {
    const p = k.proc!
    let outBuf = ''
    p.stdout.setEncoding('utf-8')
    p.stdout.on('data', (chunk: string) => {
      outBuf += chunk
      let nl: number
      while ((nl = outBuf.indexOf('\n')) >= 0) {
        const line = outBuf.slice(0, nl).trim()
        outBuf = outBuf.slice(nl + 1)
        if (line) this.onKernelLine(k, line)
      }
    })
    p.stderr.setEncoding('utf-8')
    p.stderr.on('data', (d: string) => {
      const t = d.trim()
      if (t) console.log(`[flint:kernel ${k.sessionId.slice(-6)}] ${t.slice(0, 300)}`)
    })
    p.on('exit', async (code) => {
      if (k.proc !== p) return // a newer kernel already replaced us — ignore
      // fail all pending replies
      for (const [, pend] of k.pending) {
        clearTimeout(pend.timer)
        pend.reject(new Error(`kernel exited (code ${code})`))
      }
      k.pending.clear()
      k.proc = null
      if (!k.evicted && k.restarts < MAX_RESTARTS) {
        k.restarts++
        bus.emit({
          type: 'kernel:restarted',
          source: 'agent',
          level: 'warn',
          message: `Kernel for session ${k.sessionId.slice(-6)} exited (${code}) — restart #${k.restarts}`,
          refId: k.sessionId,
        })
        await sleep(Math.min(4000, 400 * 2 ** k.restarts))
        try {
          await this.ensureKernel(k.sessionId)
          // restore the last snapshot after a crash
          if (k.snapshot) await this.restoreNow(k, k.snapshot.blob)
        } catch {
          /* supervisor gave up — next eval retries */
        }
      }
    })
  }

  private onKernelLine(k: Kernel, line: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line)
    } catch {
      console.log(`[flint:kernel ${k.sessionId.slice(-6)}] ${line.slice(0, 200)}`)
      return
    }
    const ch = msg.ch as string | undefined
    if (ch === 'host_call') {
      const hid = String(msg.hid)
      const fn = String(msg.fn)
      const args = (msg.args as unknown[]) ?? []
      k.hostCalls.set(hid, { fn, args })
      // wake any eval pump that is waiting for host calls
      for (const w of k.hostCallWaiters) w()
      k.hostCallWaiters.clear()
      // no eval pumping (background thread) — drain directly
      if (!k.busy) this.drainHostCalls(k)
      return
    }
    if (ch === 'log') {
      const level = String(msg.level ?? 'info')
      if (level === 'warn' || level === 'error') {
        console.log(`[flint:kernel ${k.sessionId.slice(-6)}] ${String(msg.message).slice(0, 300)}`)
      }
      return
    }
    const id = String(msg.id ?? '')
    const pend = k.pending.get(id)
    if (!pend) return
    k.pending.delete(id)
    clearTimeout(pend.timer)
    if (ch === 'result' || ch === 'snapshot' || ch === 'vars') {
      pend.resolve(msg)
    } else {
      pend.resolve(msg)
    }
  }

  private send(k: Kernel, obj: Record<string, unknown>): void {
    if (!k.proc || k.proc.killed) throw new Error('kernel not running')
    k.proc.stdin.write(JSON.stringify(obj) + '\n')
  }

  private request<T>(k: Kernel, id: string, obj: Record<string, unknown>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        k.pending.delete(id)
        reject(new Error(`kernel request timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      k.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      try {
        this.send(k, obj)
      } catch (e) {
        clearTimeout(timer)
        k.pending.delete(id)
        reject(e)
      }
    })
  }

  // ── public API ────────────────────────────────────────────
  /**
   * Evaluate Python code in the session's persistent kernel.
   * While waiting, host_call requests from the kernel are
   * dispatched to registered host functions (programmatic tool
   * calling) and answered back over stdin.
   */
  async eval(sessionId: string, code: string, cwd?: string, timeoutMs = EVAL_TIMEOUT_MS): Promise<KernelResult> {
    const k = await this.ensureKernel(sessionId, cwd)
    k.lastActive = Date.now()
    k.busy = true
    k.restarts = 0
    const id = `r${Date.now()}${Math.random().toString(36).slice(2, 6)}`
    try {
      const evalP = this.request<Record<string, unknown>>(k, id, { op: 'eval', id, code }, timeoutMs)
      // pump host calls until the eval resolves
      for (;;) {
        const race = await Promise.race([
          evalP.then((r) => ({ done: true as const, r })),
          this.waitHostCall(k).then(() => ({ done: false as const })),
        ])
        if (race.done) {
          return {
            ok: Boolean(race.r.ok),
            stdout: String(race.r.stdout ?? ''),
            stderr: String(race.r.stderr ?? ''),
            result: race.r.result !== undefined ? String(race.r.result) : undefined,
            durationMs: Number(race.r.durationMs ?? 0),
          }
        }
        this.drainHostCalls(k)
      }
    } finally {
      k.busy = false
      k.lastActive = Date.now()
      // eval finished — dispatch anything that arrived in the gap
      this.drainHostCalls(k)
    }
  }

  /** Resolve when a host call is queued (or immediately if one already is). */
  private waitHostCall(k: Kernel): Promise<void> {
    if (k.hostCalls.size > 0 || !k.proc || k.proc.killed) return Promise.resolve()
    return new Promise<void>((res) => {
      k.hostCallWaiters.add(res)
    })
  }

  /** Dispatch every queued host call (delete-then-dispatch is idempotent). */
  private drainHostCalls(k: Kernel): void {
    for (;;) {
      const next = k.hostCalls.entries().next()
      if (next.done) break
      const [hid, hc] = next.value
      k.hostCalls.delete(hid)
      void this.dispatchHostCall(k, hid, hc.fn, hc.args)
    }
  }

  private async dispatchHostCall(k: Kernel, hid: string, fn: string, args: unknown[]): Promise<void> {
    try {
      if (fn === '__dead__' || !hid) throw new Error('kernel died')
      const impl = this.hostFns.get(fn)
      if (!impl) throw new Error(`unknown host function "${fn}" — registered: ${[...this.hostFns.keys()].join(', ')}`)
      const result = await impl(k.sessionId, args)
      this.send(k, { op: 'host_result', hid, ok: true, result: result ?? null })
    } catch (e) {
      try {
        this.send(k, { op: 'host_result', hid, ok: false, error: String(e).slice(0, 500) })
      } catch {
        /* kernel gone */
      }
    }
  }

  /** Snapshot the kernel namespace (per-variable pickling). */
  async snapshot(sessionId: string): Promise<KernelSnapshot | null> {
    const k = this.kernels.get(sessionId)
    if (!k || !k.proc || k.proc.killed) return k?.snapshot ?? await this.loadDiskSnapshot(sessionId)
    const id = `s${Date.now()}`
    try {
      const res = (await this.request<Record<string, unknown>>(k, id, { op: 'snapshot', id }, 30_000)) as unknown as KernelSnapshot & { ok: boolean }
      if (res.ok && res.blob) {
        k.snapshot = { blob: res.blob, manifest: res.manifest ?? {} }
        void this.saveDiskSnapshot(sessionId, k.snapshot) // durable across restarts
        return k.snapshot
      }
    } catch {
      /* snapshot best-effort */
    }
    return k.snapshot ?? null
  }

  // ── disk persistence (survives server restarts) ───────────
  private snapPath(sessionId: string): string {
    return path.join(KERNELS_DIR, sessionId, 'snapshot.bin')
  }

  private async saveDiskSnapshot(sessionId: string, snap: KernelSnapshot): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.snapPath(sessionId)), { recursive: true })
      await fs.writeFile(this.snapPath(sessionId), JSON.stringify(snap), 'utf-8')
    } catch {
      /* disk snapshot best-effort */
    }
  }

  private async loadDiskSnapshot(sessionId: string): Promise<KernelSnapshot | null> {
    try {
      const raw = await fs.readFile(this.snapPath(sessionId), 'utf-8')
      return JSON.parse(raw) as KernelSnapshot
    } catch {
      return null
    }
  }

  private async restoreNow(k: Kernel, blob: string): Promise<void> {
    const id = `x${Date.now()}`
    await this.request(k, id, { op: 'restore', id, blob }, 30_000).catch(() => null)
  }

  /** Restore a snapshot into the (live or lazily relaunched) kernel. */
  async restore(sessionId: string, blob: string, cwd?: string): Promise<boolean> {
    const k = await this.ensureKernel(sessionId, cwd)
    await this.restoreNow(k, blob)
    return true
  }

  /** List live variables (name → repr). */
  async vars(sessionId: string): Promise<Record<string, string>> {
    const k = this.kernels.get(sessionId)
    if (!k || !k.proc || k.proc.killed) return {}
    const id = `v${Date.now()}`
    try {
      const res = await this.request<{ vars?: Record<string, string> }>(k, id, { op: 'vars', id }, 10_000)
      return res.vars ?? {}
    } catch {
      return {}
    }
  }

  /** Explicitly persist + stop a kernel (detach / archive). */
  async park(sessionId: string): Promise<void> {
    const k = this.kernels.get(sessionId)
    if (!k) return
    await this.snapshot(sessionId)
    this.kill(k)
  }

  private kill(k: Kernel): void {
    k.evicted = true
    k.busy = false
    const proc = k.proc
    k.proc = null
    // keep the kernel object in the map — its snapshot survives for lazy resume
    if (proc && !proc.killed) {
      try {
        proc.stdin.write(JSON.stringify({ op: 'shutdown' }) + '\n')
      } catch {
        /* already gone */
      }
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL')
      }, 1500)
    }
  }

  /** Idle eviction: snapshot + kill idle kernels (free resume later). */
  private evictIdle(): void {
    const now = Date.now()
    for (const k of this.kernels.values()) {
      if (!k.busy && now - k.lastActive > IDLE_EVICT_MS) {
        bus.emit({
          type: 'kernel:evicted',
          source: 'agent',
          message: `Kernel for session ${k.sessionId.slice(-6)} idle-evicted (snapshot kept)`,
          refId: k.sessionId,
        })
        void this.park(k.sessionId)
      }
    }
  }

  stats(): Record<string, unknown> {
    return {
      live: this.kernels.size,
      busy: [...this.kernels.values()].filter((k) => k.busy).length,
      hostFns: this.hostFns.size,
    }
  }
}

const g = globalThis as unknown as { __flintKernels?: KernelManager }
export const kernelManager: KernelManager = g.__flintKernels ?? (g.__flintKernels = new KernelManager())
export function bootKernels(): void {
  kernelManager.start()
}
