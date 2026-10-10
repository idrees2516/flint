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
  // ── RLM seeds: harness items, MCP servers, factory machines ──
  await seedHarness()
  await seedMcp()
  await seedMachines()
  // demo fleet — only on fresh DB
  if ((await db.sandbox.count()) > 0) {await seedDemoRlmSession(); return}
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
      { level: 'success', source: 'agent', message: 'RLM engine online — persistent Python kernels, subagents, A2A, factory, heartbeats' },
    ],
  })
}

// ── RLM seeds ───────────────────────────────────────────────
async function seedHarness(): Promise<void> {
  const items = [
    {
      kind: 'memory',
      name: 'platform-conventions',
      content: 'Flint is a cloud sandbox + agent orchestration platform. Compute pricing: $0.0000022/vCPU/s + $0.0000006/GB/s. Hibernated sandboxes cost ~92% less. The agent runtime prefers batching tool calls in parallel.',
      tags: 'platform,pricing',
    },
    {
      kind: 'prompt_note',
      name: 'verify-before-done',
      content: 'Before calling flint_done, verify claims with real commands (run tests, cat files, check exit codes). Never assert success without evidence.',
      tags: 'quality',
    },
    {
      kind: 'skill',
      name: 'parallel-research',
      content: 'Parallel research pattern: spawn 2-4 subagents with distinct search angles via host("spawn", name, prompt), store handles in a list, then collect them all with host("collect", h) and synthesize. Prefer angles: official docs, community discussion, source code, benchmarks.',
      tags: 'research,multi-agent',
    },
    {
      kind: 'subagent_spec',
      name: 'code-reviewer',
      content: 'A focused reviewer subagent. Prompt template: "Review {{target}} for correctness, security and style. List concrete issues with file:line. Be terse, no praise." Model: glm-4.7-flash. Returns: markdown issue list.',
      tags: 'review',
    },
  ]
  for (const i of items) {
    await db.harnessItem.upsert({
      where: { kind_name_scope: { kind: i.kind, name: i.name, scope: 'global' } },
      update: {},
      create: { ...i, scope: 'global' },
    })
  }
}

async function seedMcp(): Promise<void> {
  const servers = [
    { name: 'notion', transport: 'http', url: 'https://mcp.notion.com/mcp', enabled: false },
    { name: 'linear', transport: 'http', url: 'https://mcp.linear.app/sse', enabled: false },
    { name: 'serper', transport: 'http', url: 'https://flint-mcp.serper.dev/mcp', enabled: true },
    { name: 'github', transport: 'http', url: 'https://api.githubcopilot.com/mcp/', enabled: false },
    { name: 'filesystem', transport: 'stdio', url: '', command: 'npx -y @modelcontextprotocol/server-filesystem', enabled: false },
  ]
  for (const s of servers) {
    await db.mcpServer.upsert({
      where: { name: s.name },
      update: {},
      create: { ...s, toolCount: 0 },
    })
  }
}

async function seedMachines(): Promise<void> {
  const machines = [
    {
      slug: 'builder',
      name: 'Builder',
      description: 'Plan → implement → review → fix loop with a completion gate (tests must pass).',
      spec: {
        entry: 'plan',
        maxParallel: 3,
        nodes: [
          {
            id: 'plan',
            kind: 'agent' as const,
            title: 'Plan the implementation',
            prompt: 'Read the repo in your kernel (ls, read files). Produce a minimal implementation plan for: {{input.task}}. Output the plan only.',
            model: 'glm-4.7',
            next: ['implement'],
          },
          {
            id: 'implement',
            kind: 'agent' as const,
            title: 'Implement the plan',
            prompt: 'Implement this plan in your kernel workspace using write()/edit(). Plan:\n{{node.plan}}\nThen run the checks. Finish with flint_done(summary of what you wrote and how it went).',
            model: 'glm-4.7',
            next: ['review'],
          },
          {
            id: 'review',
            kind: 'agent' as const,
            title: 'Review the diff',
            prompt: 'Review the implementation described here for correctness and edge cases. List concrete issues or APPROVE.\nImplementation report:\n{{node.implement}}',
            model: 'glm-4.7-flash',
            next: ['fix'],
          },
          {
            id: 'fix',
            kind: 'agent' as const,
            title: 'Apply review fixes if needed',
            prompt: 'Review verdict:\n{{node.review}}\nIf changes are needed, apply them (write/edit). Then verify with real commands. If APPROVED, just confirm and finish with flint_done.',
            model: 'glm-4.7',
            next: [],
          },
        ],
      },
    },
    {
      slug: 'pr-manager',
      name: 'PR Manager',
      description: 'Fan-out PR triage: classify, summarize, and draft responses — one child per PR.',
      spec: {
        entry: 'triage',
        maxParallel: 4,
        nodes: [
          {
            id: 'triage',
            kind: 'agent' as const,
            title: 'Per-PR triage',
            foreach: ['{{input.pr}}'],
            prompt: 'Triage this PR as item {{item}}. Classify (bug|feature|refactor|docs), summarize in 2 sentences, and draft a friendly review response. Use websearch for unfamiliar code.',
            model: 'glm-4.7-flash',
            next: ['join'],
          },
          {
            id: 'join',
            kind: 'join' as const,
            title: 'Collect triage results',
            prompt: '',
            next: ['report'],
          },
          {
            id: 'report',
            kind: 'agent' as const,
            title: 'Compose the report',
            prompt: 'Compose a single markdown triage report from these results:\n{{node.join}}',
            model: 'glm-4.7',
            next: [],
          },
        ],
      },
    },
    {
      slug: 'review-sweep',
      name: 'Review Sweep',
      description: 'Sweep a repo: one reviewer per area (security, perf, style), then merge findings.',
      spec: {
        entry: 'areas',
        maxParallel: 3,
        nodes: [
          {
            id: 'areas',
            kind: 'agent' as const,
            title: 'Area reviewers',
            foreach: ['security', 'performance', 'style'],
            prompt: 'Review the repo in your kernel for {{item}} issues only. List concrete file:line findings or CLEAN. Be terse.',
            model: 'glm-4.7-flash',
            next: ['merge'],
          },
          {
            id: 'merge',
            kind: 'join' as const,
            title: 'Merge findings',
            prompt: '',
            next: ['final'],
          },
          {
            id: 'final',
            kind: 'agent' as const,
            title: 'Prioritized report',
            prompt: 'Merge these review findings into one prioritized report (P0/P1/P2):\n{{node.merge}}',
            model: 'glm-4.7',
            next: [],
          },
        ],
      },
    },
  ]
  for (const m of machines) {
    await db.factoryMachine.upsert({
      where: { slug: m.slug },
      update: {},
      create: { slug: m.slug, name: m.name, description: m.description, spec: JSON.stringify(m.spec), isOfficial: true },
    })
  }
}

/** Seed a demo RLM session with a short illustrative transcript. */
async function seedDemoRlmSession(): Promise<void> {
  if ((await db.agentSession.count()) > 0) return
  const session = await db.agentSession.create({
    data: {
      name: 'research · flint vs competitors',
      model: 'glm-4.7',
      status: 'idle',
      lastMessage: 'Compared Flint to 4 competitors on sandbox boot time, pricing and agent tooling. Full comparison in kernel variable `report`.',
      turnCount: 3,
      tokensIn: 4820,
      tokensOut: 1910,
      costUsd: 0.0062,
    },
  })
  await db.sessionMessage.createMany({
    data: [
      { sessionId: session.id, idx: 0, role: 'user', kind: 'chat', content: 'Research how Flint compares to other sandbox platforms and write a short report.' },
      {
        sessionId: session.id,
        idx: 1,
        role: 'assistant',
        kind: 'code',
        content: 'results = [websearch(f"{p} sandbox platform pricing", 5) for p in ["e2b", "daytona", "modal"]]\nhandles = [bash("sleep 0.1; echo done") for _ in results]\nreport = "\\n\\n".join(results)\nlen(report)',
      },
      { sessionId: session.id, idx: 2, role: 'tool', kind: 'stdout', content: 'stdout:\n2418\n' },
      {
        sessionId: session.id,
        idx: 3,
        role: 'assistant',
        kind: 'chat',
        content: '**Researched 4 competitors.** Flint is differentiated by: O(1) COW forks, 1s billing granularity, and the RLM agent runtime (persistent Python kernel + subagents). Full report stored in kernel variable `report`.',
      },
    ],
  })
}
