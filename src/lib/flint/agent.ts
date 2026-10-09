// ─────────────────────────────────────────────────────────────
// Flint · Agentic Task Runtime
//
// Two execution strategies:
//   react — ReAct loop. The model may emit MULTIPLE tool calls per
//           step; independent calls run in parallel through a
//           bounded Semaphore (toolConcurrency), like Claude Code.
//   dag   — Plan-then-execute. The model drafts a step DAG first;
//           the scheduler runs independent steps in parallel waves
//           (topological generations), then synthesizes.
//
// Every step is persisted (TaskStep) and streamed over the event
// bus to the UI in real time.
// ─────────────────────────────────────────────────────────────
import ZAI from 'z-ai-web-dev-sdk'
import { db } from '@/lib/db'
import { bus } from './events'
import { Semaphore, retryAsync } from './concurrency'
import { getDriver, bumpCounter } from './drivers'
import { orchestrator } from './orchestrator'
import { PRICING } from './pricing'

export interface ToolCall {
  tool: string
  input: string
}

export interface ToolResult {
  tool: string
  input: string
  ok: boolean
  output: string
  durationMs: number
}

// ── tool registry ────────────────────────────────────────────
interface ToolCtx {
  sandboxId: string | null
  workspacePath?: string | null
  driver: string
}

async function zai(): Promise<InstanceType<typeof ZAI>> {
  const g = globalThis as unknown as { __zai?: InstanceType<typeof ZAI> }
  if (!g.__zai) {
    const z = await ZAI.create()
    g.__zai = z as unknown as InstanceType<typeof ZAI>
  }
  return g.__zai
}

const TOOLS: Record<string, { desc: string; run: (input: string, ctx: ToolCtx) => Promise<string> }> = {
  exec: {
    desc: 'Run a shell command inside the sandbox workspace. Input: the command string.',
    run: async (input, ctx) => {
      if (!ctx.sandboxId) return 'no sandbox attached'
      const sbx = await db.sandbox.findUnique({ where: { id: ctx.sandboxId } })
      if (!sbx) return 'sandbox not found'
      const driver = getDriver(sbx.driver)
      const spec = { id: sbx.id, name: sbx.name, vcpu: sbx.vcpu, memoryGb: sbx.memoryGb, diskGb: sbx.diskGb, region: sbx.region }
      if (sbx.status !== 'running') {
        await orchestrator.submit(sbx.id, 'start', 0)
      }
      const res = await driver.exec(spec, sbx.workspacePath ?? process.cwd(), input)
      bumpCounter(sbx.id, res.stdout.length + res.stderr.length)
      orchestrator.touch(sbx.id)
      return `$ ${input}\n${res.stdout}${res.stderr}\n[exit ${res.exitCode} · ${res.durationMs}ms]`
    },
  },
  list_files: {
    desc: 'List files in the sandbox workspace (optionally a subpath). Input: relative path or "."',
    run: async (input, ctx) => {
      if (!ctx.sandboxId) return 'no sandbox attached'
      const sbx = await db.sandbox.findUnique({ where: { id: ctx.sandboxId } })
      if (!sbx?.workspacePath) return 'no workspace'
      const dir = await TOOLS.exec.run(`find ${JSON.stringify(input || '.')} -maxdepth 2 -not -path '*/node_modules*' | head -60`, ctx)
      return dir
    },
  },
  read_file: {
    desc: 'Read a text file from the sandbox workspace. Input: relative file path.',
    run: (input, ctx) => TOOLS.exec.run(`cat ${JSON.stringify(input)}`, ctx),
  },
  write_file: {
    desc: 'Write/create a text file in the sandbox workspace. Input format: "path:::content"',
    run: async (input, ctx) => {
      const [p, ...rest] = input.split(':::')
      const content = rest.join(':::')
      return TOOLS.exec.run(`mkdir -p $(dirname ${JSON.stringify(p)}) && cat > ${JSON.stringify(p)} <<'FLINTEOF'\n${content}\nFLINTEOF\necho "wrote ${p} ($(echo -n ${JSON.stringify(content)} | wc -c) bytes)"`, ctx)
    },
  },
  web_search: {
    desc: 'Search the web for current information. Input: search query.',
    run: async (input) => {
      try {
        const z = await zai()
        const results = (await z.functions.invoke('web_search', { query: input, num: 5 })) as { name: string; url: string; snippet: string }[]
        return results.map((r, i) => `${i + 1}. ${r.name} (${r.url})\n   ${r.snippet}`).join('\n')
      } catch (e) {
        return `search failed: ${String(e)}`
      }
    },
  },
  metrics: {
    desc: 'Get live sandbox resource metrics (CPU/RAM/disk/uptime). Input: empty.',
    run: async (_input, ctx) => {
      if (!ctx.sandboxId) return 'no sandbox attached'
      const { fleetMetricsFor } = await import('./metrics')
      return JSON.stringify(await fleetMetricsFor(ctx.sandboxId))
    },
  },
}

export const TOOL_NAMES = Object.keys(TOOLS)

export function toolCatalog(): string {
  return TOOL_NAMES.map((n) => `- ${n}: ${TOOLS[n].desc}`).join('\n')
}

// ── LLM helpers ──────────────────────────────────────────────
async function chat(messages: { role: 'system' | 'user' | 'assistant'; content: string }[], maxTokens = 1200): Promise<string> {
  const z = await zai()
  const completion = await retryAsync(
    () =>
      z.chat.completions.create({
        messages,
        thinking: { type: 'disabled' },
        max_tokens: maxTokens,
        temperature: 0.2,
      }),
    { retries: 2, baseMs: 400 }
  )
  return (completion.choices[0]?.message?.content ?? '').trim()
}

function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```json|```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1) return null
  try {
    return JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    return null
  }
}

// ── step persistence + streaming ─────────────────────────────
async function addStep(
  taskId: string,
  idx: number,
  kind: string,
  data: { tool?: string; status?: string; parallel?: boolean; input?: string; output?: string; durationMs?: number; startedAt?: Date }
): Promise<string> {
  const step = await db.taskStep.create({
    data: {
      taskId,
      idx,
      kind,
      tool: data.tool,
      status: data.status ?? 'ok',
      parallel: data.parallel ?? false,
      input: (data.input ?? '').slice(0, 4000),
      output: (data.output ?? '').slice(0, 12000),
      durationMs: data.durationMs,
      startedAt: data.startedAt,
    },
  })
  bus.emit({
    type: 'task:step',
    source: 'agent',
    message: `${kind} · ${data.tool ?? ''} ${data.status ?? ''}`.trim(),
    refId: taskId,
    data: { step },
  })
  return step.id
}

async function accountTokens(taskId: string, inText: string, outText: string): Promise<void> {
  const tokensIn = Math.ceil(inText.length / 3.6)
  const tokensOut = Math.ceil(outText.length / 3.6)
  const cost = (tokensIn / 1000) * PRICING.llmInPer1k + (tokensOut / 1000) * PRICING.llmOutPer1k
  await db.agentTask.update({
    where: { id: taskId },
    data: { tokensIn: { increment: tokensIn }, tokensOut: { increment: tokensOut }, costUsd: { increment: cost } },
  })
  await db.usageEvent.create({ data: { sandboxId: 'agent-runtime', kind: 'agent-llm', seconds: 0, costUsd: cost } }).catch(() => {})
}

const cancelled = new Set<string>()
export function cancelTask(taskId: string): void {
  cancelled.add(taskId)
}

// ── parallel tool executor (the perf core) ───────────────────
async function runToolsParallel(taskId: string, calls: ToolCall[], ctx: ToolCtx, concurrency: number, baseIdx: number): Promise<ToolResult[]> {
  const sem = new Semaphore(Math.max(1, Math.min(8, concurrency)))
  const t0 = Date.now()
  const results = await sem.map(calls, async (call, i) => {
    const st = Date.now()
    const stepId = await addStep(taskId, baseIdx + i, 'tool_call', {
      tool: call.tool,
      status: 'running',
      parallel: calls.length > 1,
      input: call.input,
      startedAt: new Date(),
    })
    try {
      const tool = TOOLS[call.tool]
      if (!tool) throw new Error(`unknown tool "${call.tool}"`)
      const output = await tool.run(call.input, ctx)
      const durationMs = Date.now() - st
      await db.taskStep.update({ where: { id: stepId }, data: { status: 'ok', output, durationMs } })
      return { tool: call.tool, input: call.input, ok: true, output, durationMs }
    } catch (e) {
      const durationMs = Date.now() - st
      const output = `error: ${String(e)}`
      await db.taskStep.update({ where: { id: stepId }, data: { status: 'error', output, durationMs } })
      return { tool: call.tool, input: call.input, ok: false, output, durationMs }
    }
  })
  const totalMs = Date.now() - t0
  const sequential = results.reduce((a, r) => a + r.durationMs, 0)
  if (results.length > 1) {
    bus.emit({
      type: 'task:step',
      source: 'agent',
      level: 'success',
      message: `⚡ ${results.length} tools in parallel: ${totalMs}ms wall vs ${sequential}ms sequential (${(sequential / Math.max(1, totalMs)).toFixed(1)}× speedup)`,
      refId: taskId,
      data: { parallel: results.length, totalMs, sequential, speedup: sequential / Math.max(1, totalMs) },
    })
  }
  return results
}

// ── main entrypoint ──────────────────────────────────────────
export async function runAgentTask(taskId: string): Promise<void> {
  const task = await db.agentTask.findUnique({ where: { id: taskId }, include: { sandbox: true } })
  if (!task) return
  const sbx = task.sandbox
  const ctx: ToolCtx = {
    sandboxId: sbx?.id ?? null,
    workspacePath: sbx?.workspacePath ?? null,
    driver: sbx?.driver ?? 'local',
  }
  await db.agentTask.update({ where: { id: taskId }, data: { status: 'running', startedAt: new Date() } })
  bus.emit({ type: 'task:running', source: 'agent', message: `Task "${task.name}" started (${task.strategy})`, refId: taskId })

  try {
    let final = ''
    if (task.strategy === 'dag') {
      final = await runDagStrategy(task, ctx)
    } else {
      final = await runReactStrategy(task, ctx)
    }
    await db.agentTask.update({
      where: { id: taskId },
      data: { status: cancelled.has(taskId) ? 'cancelled' : 'done', result: final, finishedAt: new Date() },
    })
    bus.emit({ type: 'task:done', level: 'success', source: 'agent', message: `Task "${task.name}" completed`, refId: taskId })
  } catch (e) {
    await db.agentTask.update({
      where: { id: taskId },
      data: { status: 'failed', error: String(e).slice(0, 500), finishedAt: new Date() },
    })
    bus.emit({ type: 'task:failed', level: 'error', source: 'agent', message: `Task "${task.name}" failed: ${String(e).slice(0, 200)}`, refId: taskId })
  } finally {
    cancelled.delete(taskId)
  }
}

// ── strategy A: ReAct with parallel tool calls ───────────────
async function runReactStrategy(
  task: { id: string; prompt: string; maxSteps: number; toolConcurrency: number; name: string },
  ctx: ToolCtx
): Promise<string> {
  const system = `You are Flint Agent, an autonomous agent that lives inside a cloud sandbox. You accomplish the user's goal step by step.

TOOLS:
${toolCatalog()}

Each turn, respond with ONLY a JSON object (no prose, no markdown fences):
{"thought":"...","actions":[{"tool":"...","input":"..."}],"done":false}
or when finished:
{"thought":"...","final":"concise summary of what you did and found","done":true}

Rules:
- You may list MULTIPLE actions in one turn. Independent actions will run in PARALLEL — batch aggressively.
- Keep tool inputs small and focused. Prefer exact commands.
- After observing results, decide the next turn.
- Max ${task.maxSteps} turns.`

  const history: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: system },
    { role: 'user', content: task.prompt },
  ]

  let stepIdx = 0
  let finalText = ''
  for (let turn = 0; turn < task.maxSteps; turn++) {
    if (cancelled.has(task.id)) {
      finalText = 'cancelled by user'
      break
    }
    const raw = await chat(history)
    await accountTokens(task.id, history[history.length - 1].content + system, raw)
    const parsed = extractJson(raw)
    if (!parsed) {
      history.push({ role: 'assistant', content: raw })
      history.push({ role: 'user', content: 'Respond with valid JSON only: {"thought":..., "actions":[...], "done":...}' })
      continue
    }
    const thought = String(parsed.thought ?? '')
    const isDone = Boolean(parsed.done) || Boolean(parsed.final)
    await addStep(task.id, stepIdx++, 'thought', { output: thought })

    if (isDone) {
      finalText = String(parsed.final ?? thought)
      await addStep(task.id, stepIdx++, 'final', { output: finalText })
      break
    }
    const actions = (Array.isArray(parsed.actions) ? parsed.actions : []) as ToolCall[]
    if (actions.length === 0) {
      history.push({ role: 'assistant', content: raw })
      history.push({ role: 'user', content: 'No actions provided. Either act with tools or finish with {"done":true,"final":"..."}' })
      continue
    }
    history.push({ role: 'assistant', content: raw })
    const results = await runToolsParallel(task.id, actions.slice(0, 6), ctx, task.toolConcurrency, stepIdx)
    stepIdx += results.length
    const observation = results
      .map((r) => `[${r.tool}${r.ok ? '' : ' ✗'} · ${r.durationMs}ms]\n${r.output.slice(0, 3000)}`)
      .join('\n\n---\n\n')
    history.push({ role: 'user', content: `OBSERVATIONS:\n${observation}` })
  }
  if (!finalText) finalText = 'Reached max steps.'
  return finalText
}

// ── strategy B: DAG plan → parallel waves → synthesize ──────
interface PlanStep {
  title: string
  tool: string
  input: string
  dependsOn: number[]
}

async function runDagStrategy(
  task: { id: string; prompt: string; maxSteps: number; toolConcurrency: number; name: string },
  ctx: ToolCtx
): Promise<string> {
  // Phase 1 — plan
  await db.agentTask.update({ where: { id: task.id }, data: { status: 'planning' } })
  const planRaw = await chat(
    [
      {
        role: 'system',
        content: `You are Flint Agent planner. Break the goal into a DAG of tool steps. Respond ONLY with JSON:
{"steps":[{"title":"...","tool":"...","input":"...","dependsOn":[step indexes, 0-based]}]}

TOOLS:
${toolCatalog()}

Rules: max ${Math.min(task.maxSteps, 8)} steps. steps with no shared dependencies run in PARALLEL — structure the DAG to maximize parallelism. dependsOn lists indexes of steps that must finish first.`,
      },
      { role: 'user', content: task.prompt },
    ],
    900
  )
  await accountTokens(task.id, task.prompt, planRaw)
  const plan = extractJson(planRaw)
  const steps = ((plan?.steps as PlanStep[]) ?? []).slice(0, 8).filter((s) => TOOL_NAMES.includes(s.tool))
  await db.agentTask.update({ where: { id: task.id }, data: { plan: JSON.stringify(steps) } })
  await addStep(task.id, 0, 'thought', {
    output: `Plan: ${steps.map((s, i) => `${i}. ${s.title} (${s.tool})${s.dependsOn.length ? ` ← [${s.dependsOn.join(',')}]` : ''}`).join('  ·  ')}`,
  })
  if (steps.length === 0) return 'planner produced no executable steps'

  // Phase 2 — execute in topological waves (parallel within wave)
  const done = new Map<number, string>()
  let idx = 1
  let guard = 0
  while (done.size < steps.length && guard++ < 12) {
    if (cancelled.has(task.id)) return 'cancelled by user'
    const wave = steps
      .map((s, i) => ({ s, i }))
      .filter(({ i }) => !done.has(i))
      .filter(({ s }) => s.dependsOn.every((d) => done.has(d) || d < 0 || d >= steps.length))
    if (wave.length === 0) break
    const ctxEnriched = wave.map(({ s, i }) => {
      const depContext = s.dependsOn.map((d) => done.get(d)).filter(Boolean).join('\n')
      return { tool: s.tool, input: depContext ? `${s.input}\n(context from prior steps):\n${depContext.slice(0, 1500)}` : s.input }
    })
    const results = await runToolsParallel(task.id, ctxEnriched, ctx, task.toolConcurrency, idx)
    idx += results.length
    wave.forEach(({ i }, k) => done.set(i, results[k]?.output ?? ''))
  }

  // Phase 3 — synthesize
  const synthesis = await chat(
    [
      { role: 'system', content: 'You are Flint Agent. Summarize the completed plan and results for the user. Be concise, concrete, cite key outputs. Max 180 words.' },
      {
        role: 'user',
        content: `GOAL: ${task.prompt}\n\nPLAN+RESULTS:\n${[...done.entries()].map(([i, out]) => `${i + 1}. ${steps[i].title}\n${out.slice(0, 1800)}`).join('\n\n')}`,
      },
    ],
    500
  )
  await accountTokens(task.id, task.prompt, synthesis)
  await addStep(task.id, idx, 'final', { output: synthesis })
  return synthesis
}
