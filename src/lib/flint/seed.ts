// ─────────────────────────────────────────────────────────────
// Flint · Seed — official template catalog + demo fleet.
// Idempotent: safe to call on every boot.
// ─────────────────────────────────────────────────────────────
import { db } from '@/lib/db'

const TEMPLATES = [
  {
    slug: 'ubuntu-24-04',
    name: 'Ubuntu 24.04 LTS',
    description: 'Bare Ubuntu with build-essential, git, curl, SSH. The permissive base boat made famous — minus the price.',
    category: 'runtime',
    icon: 'terminal',
    baseImage: 'ubuntu:24.04',
    packages: 'build-essential,git,curl,wget,ssh',
    tags: 'base,linux,ssh',
    bootSeconds: 2,
    sizeMb: 480,
  },
  {
    slug: 'node-22',
    name: 'Node.js 22',
    description: 'Node 22 + bun + pnpm + yarn. Zero-config JS/TS runtime for agents that build and test code.',
    category: 'runtime',
    icon: 'hexagon',
    baseImage: 'ubuntu:24.04',
    packages: 'nodejs22,bun,pnpm,yarn',
    tags: 'node,javascript,typescript',
    bootSeconds: 3,
    sizeMb: 720,
  },
  {
    slug: 'python-3-12',
    name: 'Python 3.12 + Data',
    description: 'Python 3.12, pandas, numpy, matplotlib, jupyter, uv. For analysis and scraping agents.',
    category: 'data',
    icon: 'bar-chart-3',
    baseImage: 'ubuntu:24.04',
    packages: 'python3.12,pandas,numpy,matplotlib,jupyter,uv',
    tags: 'python,data,ml',
    bootSeconds: 3,
    sizeMb: 980,
  },
  {
    slug: 'desktop-chrome',
    name: 'Desktop + Chrome',
    description: 'Full XFCE desktop, Chrome, and Xvfb — every sandbox ships a GUI, like boat. Drive it via agent or VNC.',
    category: 'desktop',
    icon: 'monitor',
    baseImage: 'ubuntu:24.04',
    packages: 'xfce4,chromium,x11vnc,xvfb',
    tags: 'desktop,browser,chrome,vnc',
    bootSeconds: 6,
    sizeMb: 1850,
  },
  {
    slug: 'browser-agent',
    name: 'Headless Browser Agent',
    description: 'Playwright + Chromium pre-warmed. The Browserbase-killer: real Chrome at VM prices, not per-session markups.',
    category: 'browser',
    icon: 'globe',
    baseImage: 'ubuntu:24.04',
    packages: 'playwright,chromium,ffmpeg',
    tags: 'browser,playwright,scraping',
    bootSeconds: 4,
    sizeMb: 1420,
  },
  {
    slug: 'docker-in-docker',
    name: 'Docker + /dev/kvm',
    description: 'DinD with KVM passthrough. Build images, run microVMs, test CI pipelines at full speed.',
    category: 'runtime',
    icon: 'container',
    baseImage: 'ubuntu:24.04',
    packages: 'docker,kvm,qemu',
    tags: 'docker,kvm,ci',
    bootSeconds: 5,
    sizeMb: 1650,
  },
  {
    slug: 'cuda-gpu',
    name: 'CUDA GPU Runtime',
    description: 'CUDA 12 + PyTorch. Attach A100/L4s fractionally — pay per-second, only while training.',
    category: 'data',
    icon: 'zap',
    baseImage: 'nvidia/cuda:12.4',
    packages: 'cuda12.4,pytorch,cuDNN',
    tags: 'gpu,cuda,pytorch',
    bootSeconds: 8,
    sizeMb: 4200,
  },
  {
    slug: 'go-rust',
    name: 'Go 1.23 + Rust 1.81',
    description: 'Compiled-language toolchains with sccache for 2.9× faster rebuild loops.',
    category: 'runtime',
    icon: 'code',
    baseImage: 'ubuntu:24.04',
    packages: 'go1.23,rust,sccache,mold',
    tags: 'go,rust,build',
    bootSeconds: 3,
    sizeMb: 1100,
  },
]

export async function seedFlint(): Promise<void> {
  // templates
  for (const t of TEMPLATES) {
    await db.template.upsert({ where: { slug: t.slug }, update: t, create: t })
  }
  // budget row
  if ((await db.budget.count()) === 0) {
    await db.budget.create({ data: { monthlyLimitUsd: 20, alertThreshold: 0.8 } })
  }
  // demo fleet — only on fresh DB
  if ((await db.sandbox.count()) > 0) return
  const tpl = async (slug: string) => (await db.template.findUnique({ where: { slug } }))?.id
  const mk = async (data: {
    name: string
    status: string
    driver?: string
    region?: string
    templateSlug?: string
    vcpu?: number
    memoryGb?: number
    hibernateAfterMin?: number
  }) => {
    await db.sandbox.create({
      data: {
        name: data.name,
        status: data.status,
        driver: data.driver ?? 'local',
        region: data.region ?? 'us-east-1',
        templateId: data.templateSlug ? await tpl(data.templateSlug) : null,
        vcpu: data.vcpu ?? 2,
        memoryGb: data.memoryGb ?? 4,
        hibernateAfterMin: data.hibernateAfterMin ?? 15,
        startedAt: data.status === 'running' ? new Date() : null,
        workspacePath: null,
      },
    })
  }
  await mk({ name: 'flint-build-runner', status: 'running', templateSlug: 'node-22', vcpu: 4, memoryGb: 8, hibernateAfterMin: 10 })
  await mk({ name: 'scrape-fleet-a', status: 'running', driver: 'cloud-vm', templateSlug: 'browser-agent', region: 'eu-west-1', vcpu: 2, memoryGb: 4 })
  await mk({ name: 'ml-train-scratch', status: 'hibernated', driver: 'cloud-vm', templateSlug: 'cuda-gpu', region: 'us-west-2', vcpu: 8, memoryGb: 32, hibernateAfterMin: 5 })
  await mk({ name: 'legacy-batch', status: 'stopped', templateSlug: 'python-3-12', region: 'ap-south-1', vcpu: 2, memoryGb: 2 })
  // seed a demo agent task (done) so the UI has history
  const sbx = await db.sandbox.findFirst({ where: { name: 'flint-build-runner' } })
  if (sbx) {
    const task = await db.agentTask.create({
      data: {
        name: 'Nightly dependency audit',
        prompt: 'Check node deps for vulnerabilities and write SECURITY.md summary',
        sandboxId: sbx.id,
        status: 'done',
        strategy: 'react',
        result: 'Audited 412 packages · 2 moderate advisories (lodash, postcss) · pinned safe ranges · SECURITY.md written.',
        tokensIn: 2140,
        tokensOut: 862,
        costUsd: 0.012,
        startedAt: new Date(Date.now() - 3600_000),
        finishedAt: new Date(Date.now() - 3600_000 + 92_000),
      },
    })
    await db.taskStep.createMany({
      data: [
        { taskId: task.id, idx: 0, kind: 'thought', output: 'Plan: inspect package.json, run audit, summarize.' },
        { taskId: task.id, idx: 1, kind: 'tool_call', tool: 'exec', status: 'ok', input: 'cat package.json | head -40', output: '{ "name": "web", "dependencies": { "lodash": "^4.17.20", ... } }', durationMs: 210 },
        { taskId: task.id, idx: 2, kind: 'tool_call', tool: 'exec', status: 'ok', input: 'npm audit --json | tail -20', output: '2 moderate advisories', durationMs: 3400 },
        { taskId: task.id, idx: 3, kind: 'final', output: 'Audited 412 packages · 2 moderate advisories · SECURITY.md written.' },
      ],
    })
  }
  // event log welcome entries
  await db.eventLog.createMany({
    data: [
      { level: 'success', source: 'fleet', message: 'Flint control plane online — 24 orchestrator lanes, 1s metering' },
      { level: 'info', source: 'billing', message: 'Per-second billing active · $0.008/hr per 2vCPU·4GB' },
      { level: 'info', source: 'agent', message: 'Agent runtime ready · react + dag strategies, parallel tools' },
    ],
  })
}
