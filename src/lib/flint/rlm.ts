// ─────────────────────────────────────────────────────────────
// Flint · RLM Session Engine (prime-agent parity)
//
// The Recursive Language Model paradigm:
//   • every session owns a persistent Python kernel
//   • the model's tool surface IS the kernel — it writes Python
//     that calls tool functions (bash, edit, websearch, spawn…)
//     — "prompt-as-a-variable, tools-as-function-calls"
//   • context is delegated to kernel variables and sub-LLMs;
//     compaction folds the transcript, never the REPL state
//   • subagents are full recursive sessions (own kernel, model,
//     transcript) spawned via host("spawn", ...)
//   • A2A messaging within the nuclear family with steer and
//     follow-up delivery modes
// ─────────────────────────────────────────────────────────────
import { db } from '@/lib/db'
import { bus } from './events'
import { kernelManager } from './kernel'
import { findModel, DEFAULT_MODEL, modelCost } from './models'
import { harnessPromptBlocks, upsertItem as harnessUpsert, listItems as harnessList, bumpUse } from './harness'
import { listTools as mcpListTools, callTool as mcpCallTool, mcpOverview } from './mcp'
import { getDriver, counterState } from './drivers'
import { Semaphore } from './concurrency'
import { clearTurnCancel, isTurnCancelled } from './acp'

// ── constants ───────────────────────────────────────────────
const MAX_TURNS_PER_REQUEST = 8 // iterations of code↔observation per user turn
const COMPACT_AT_TOKENS = 24_000 // auto-compact threshold (estimated)
const KEEP_RECENT_MESSAGES = 10 // messages kept raw after compaction
const RLM_MAX_DEPTH = 4 // subagent recursion cap
const estTokens = (s: string) => Math.ceil(s.length / 3.6)

// ── LLM access ──────────────────────────────────────────────
interface ZaiClient {
  chat: {
    completions: {
      create: (args: Record<string, unknown>) => Promise<{ choices: Array<{ message?: { content?: string } }> }>
    }
  }
  functions: { invoke: (fn: string, args: Record<string, unknown>) => Promise<unknown> }
}

async function zai(): Promise<ZaiClient> {
  const ZAI = (await import('z-ai-web-dev-sdk')).default
  const g = globalThis as unknown as { __zai?: ZaiClient }
  if (!g.__zai) g.__zai = (await ZAI.create()) as unknown as ZaiClient
  return g.__zai
}

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export async function llmChat(messages: ChatMsg[], opts: { model?: string; maxTokens?: number; temperature?: number } = {}): Promise<string> {
  const z = await zai()
  const completion = await z.chat.completions.create({
    messages,
    thinking: { type: 'disabled' },
    max_tokens: opts.maxTokens ?? 1600,
    temperature: opts.temperature ?? 0.2,
  })
  return (completion.choices[0]?.message?.content ?? '').trim()
}

// ── session CRUD ────────────────────────────────────────────
export async function createSession(input: {
  name: string
  model?: string
  provider?: string
  thinkingLevel?: string
  sandboxId?: string | null
  parentId?: string | null
  role?: string
  forkOfId?: string | null
}) {
  const parent = input.parentId ? await db.agentSession.findUnique({ where: { id: input.parentId } }) : null
  const depth = parent ? parent.depth + 1 : 0
  if (depth > RLM_MAX_DEPTH) throw new Error(`rlm max depth (${RLM_MAX_DEPTH}) exceeded`)
  const model = input.model && findModel(input.model) ? input.model : parent?.model ?? DEFAULT_MODEL
  const session = await db.agentSession.create({
    data: {
      name: input.name,
      role: input.role ?? (parent ? 'subagent' : 'main'),
      depth,
      parentId: parent?.id ?? null,
      forkOfId: input.forkOfId ?? null,
      provider: input.provider ?? 'zai',
      model,
      thinkingLevel: input.thinkingLevel ?? 'off',
      sandboxId: input.sandboxId ?? parent?.sandboxId ?? null,
      status: 'idle',
      lastMessage: '',
    },
  })
  bus.emit({
    type: 'session:created',
    source: 'agent',
    message: parent
      ? `subagent "${session.name}" spawned (depth ${depth} · ${model})`
      : `session "${session.name}" created (${model})`,
    refId: session.id,
    data: { sessionId: session.id, depth, model, role: session.role },
  })
  return session
}

export async function forkSession(sessionId: string, name?: string) {
  const src = await db.agentSession.findUnique({ where: { id: sessionId } })
  if (!src) throw new Error('session not found')
  const fork = await createSession({
    name: name ?? `${src.name} (fork)`,
    model: src.model,
    sandboxId: src.sandboxId,
    forkOfId: src.id,
  })
  // copy the transcript (post-compaction view) into the fork
  const msgs = await transcriptFor(src.id)
  let idx = 0
  for (const m of msgs) {
    if (m.role === 'system') continue
    await appendMessage(fork.id, idx++, m.role, m.kind, m.content)
  }
  // snapshot the source kernel and restore into the fork's kernel
  const snap = await kernelManager.snapshot(sessionId)
  if (snap) await kernelManager.restore(fork.id, snap.blob).catch(() => null)
  return fork
}

export async function listSessions(role?: string) {
  return db.agentSession.findMany({
    where: role ? { role } : {},
    orderBy: { lastActiveAt: 'desc' },
    take: 100,
    include: {
      _count: { select: { messages: true, children: true, inbox: { where: { status: 'pending' } } } },
    },
  })
}

export async function getSession(sessionId: string) {
  return db.agentSession.findUnique({
    where: { id: sessionId },
    include: {
      parent: { select: { id: true, name: true } },
      children: { select: { id: true, name: true, status: true, depth: true, lastMessage: true, model: true } },
      messages: { orderBy: { idx: 'asc' } },
      goals: { orderBy: { createdAt: 'desc' }, take: 3 },
      heartbeats: { orderBy: { createdAt: 'desc' } },
    },
  })
}

// ── transcript (append-only JSONL-equivalent) ───────────────
export async function appendMessage(
  sessionId: string,
  idx: number,
  role: string,
  kind: string,
  content: string,
  meta: Record<string, unknown> = {},
  usage: { tokensIn?: number; tokensOut?: number; costUsd?: number } = {}
) {
  const msg = await db.sessionMessage.create({
    data: {
      sessionId,
      idx,
      role,
      kind,
      content: content.slice(0, 40_000),
      meta: JSON.stringify(meta).slice(0, 8_000),
      tokensIn: usage.tokensIn ?? 0,
      tokensOut: usage.tokensOut ?? 0,
      costUsd: usage.costUsd ?? 0,
    },
  })
  return msg
}

/** The post-compaction transcript view used for LLM calls. */
export async function transcriptFor(sessionId: string): Promise<Array<{ id: string; idx: number; role: string; kind: string; content: string }>> {
  const all = await db.sessionMessage.findMany({ where: { sessionId }, orderBy: { idx: 'asc' } })
  // start from the newest summary (compaction boundary), if any
  let start = 0
  for (let i = 0; i < all.length; i++) if (all[i].kind === 'summary') start = i
  return all.slice(start)
}

// ── system prompt assembly (layered, cache-stable) ──────────
export async function systemPrompt(sessionId: string): Promise<string> {
  const session = await db.agentSession.findUnique({ where: { id: sessionId } })
  if (!session) throw new Error('session not found')
  const harness = await harnessPromptBlocks(sessionId)
  const mcp = await mcpOverview()
  const mcpBlock = mcp.length
    ? 'MCP SERVERS (call via mcp_list_tools(name) / mcp_call(name, tool, args)):\n' +
      mcp.map((s) => `- ${s.name} (${s.transport}, ${s.toolCount} tools${s.enabled ? '' : ', disabled'})`).join('\n')
    : ''
  const sandbox = session.sandboxId
    ? await db.sandbox.findUnique({ where: { id: session.sandboxId } })
    : null
  const roleLine =
    session.role === 'subagent'
      ? `You are a SUBAGENT (depth ${session.depth}). Do your scoped task well, then finish with flint_done(summary). Be terse.`
      : session.role === 'factory-node'
        ? 'You are a FACTORY NODE agent. Execute your node spec, then finish with flint_done(output).'
        : 'You are the user\'s primary agent.'

  return `You are Flint Agent — a general-purpose agent with a persistent Python kernel (RLM: Recursive Language Model).
${roleLine}

# The kernel
You have a PERSISTENT Python namespace across turns: variables, imports, and background processes survive.
Available kernel functions:
- bash(cmd) → background shell handle: .output(timeout), .tail(n), .poll(), .kill(), .running, .pid
- read(path), write(path, content), edit(path, old_str, new_str) (exact unique match), ls(path)
- websearch(query, num=5) → search results (titles, urls, snippets)
- host(fn, *args) → host-side tools (below)

# Programmatic tool calling
Each turn, respond with ONE fenced Python code block (\`\`\`python ... \`\`\`) and NOTHING else — no labels, no prose outside the
block. Your past code turns are shown back as fenced blocks; observations come as fenced output. Keep that exact format.
It runs in your kernel; stdout + the last expression's value come back as the observation. Batch aggressively — spawn
parallel bash handles, then collect. Store useful intermediate state in variables (it persists). Do NOT re-derive
facts you already computed.

# Host tools (call via host(...))
- host("spawn", name, prompt, model="glm-4.7-flash") → subagent handle (its own kernel + model)
- host("collect", handle, timeout_sec=120) → {"status","result"} — wait for a subagent
- host("progress_note", note) → tell your parent how it's going
- host("list_agents") / host("observe_agent", id) / host("recent_messages") → observe the family
- host("send_message", to, body, mode="follow-up"|"steer") → A2A message ("*" broadcasts to siblings/children)
- host("mcp_list_tools", server) / host("mcp_call", server, tool, args)
- host("harness_list", kind) / host("harness_get", kind, name) / host("harness_upsert", kind, name, content)
- host("compact_run", instructions) → fold old transcript into a summary (kernel state untouched)
- host("goal_get") / host("goal_complete", summary)
- host("factory_run", machine_slug, input) → run a multi-agent workflow machine
- host("metrics") → sandbox resource metrics

# Finishing
When the user's request is fully handled, call flint_done(summary) — a clear, concrete summary of what you did
and found. Until then, keep working the problem with code. Avoid asking questions you can answer with tools.
${harness ? `\n${harness}` : ''}${mcpBlock ? `\n${mcpBlock}` : ''}

# Environment
- kernel cwd: your sandbox workspace${sandbox ? ` (sandbox "${sandbox.name}", ${sandbox.driver}, ${sandbox.region})` : ' (no sandbox attached)'}
- model: ${session.model} · thinking: ${session.thinkingLevel}
- session: ${session.name} (${session.id.slice(-6)})`
}

// ── compaction ──────────────────────────────────────────────
export async function compactSession(sessionId: string, instructions = ''): Promise<boolean> {
  const session = await db.agentSession.findUnique({ where: { id: sessionId } })
  if (!session) return false
  const all = await db.sessionMessage.findMany({ where: { sessionId }, orderBy: { idx: 'asc' } })
  if (all.length <= KEEP_RECENT_MESSAGES + 2) return false
  const fold = all.slice(0, all.length - KEEP_RECENT_MESSAGES)
  const keep = all.slice(all.length - KEEP_RECENT_MESSAGES)
  const foldText = fold
    .map((m) => `[${m.role}/${m.kind}] ${m.content.slice(0, 1500)}`)
    .join('\n')
  const summary = await llmChat(
    [
      {
        role: 'system',
        content:
          'You compact an agent transcript. Produce a dense summary preserving: goals, key facts, file/variable state, decisions, open threads, and any numbers/IDs needed later. Max 400 words. ' +
          (instructions ? `Focus: ${instructions}` : ''),
      },
      { role: 'user', content: foldText.slice(0, 24_000) },
    ],
    { maxTokens: 700 }
  ).catch(() => 'compaction unavailable — retained headings only:\n' + foldText.slice(0, 3000))
  const maxIdx = all[all.length - 1]?.idx ?? 0
  await appendMessage(sessionId, maxIdx + 1, 'system', 'summary', `TRANSCRIPT SUMMARY (compacted #${session.compactCount + 1}):\n${summary}`)
  // delete the folded originals (append-only view maintained by the summary boundary)
  await db.sessionMessage.deleteMany({ where: { sessionId, idx: { in: fold.map((m) => m.idx) } } })
  await db.agentSession.update({
    where: { id: sessionId },
    data: { compactCount: { increment: 1 }, compactedAt: new Date() },
  })
  bus.emit({
    type: 'session:compacted',
    source: 'agent',
    message: `session "${session.name}" compacted (${fold.length} → 1 summary msg, kernel state untouched)`,
    refId: sessionId,
  })
  return true
}

// ── A2A messaging ───────────────────────────────────────────
export async function sendAgentMessage(fromId: string, toId: string, body: string, mode: 'steer' | 'follow-up' = 'follow-up') {
  if (toId === '*') {
    // broadcast to the nuclear family: siblings + children
    const me = await db.agentSession.findUnique({ where: { id: fromId } })
    if (!me) throw new Error('sender not found')
    const family = await db.agentSession.findMany({
      where: {
        OR: [
          { parentId: me.parentId, depth: me.depth }, // siblings (incl. self — filtered below)
          { parentId: fromId }, // children
        ],
      },
    })
    const targets = family.filter((f) => f.id !== fromId)
    for (const t of targets) {
      await db.agentMessage.create({ data: { fromId, toId: t.id, body, mode } })
    }
    bus.emit({
      type: 'a2a:sent',
      source: 'agent',
      message: `${me.name} broadcast → ${targets.length} agents (${mode})`,
      refId: fromId,
    })
    return { broadcast: true, delivered: targets.length }
  }
  // daemon-enforced nuclear family check
  const [from, to] = await Promise.all([
    db.agentSession.findUnique({ where: { id: fromId } }),
    db.agentSession.findUnique({ where: { id: toId } }),
  ])
  if (!from || !to) throw new Error('sender or recipient not found')
  const inFamily =
    to.parentId === from.parentId || // siblings
    to.parentId === from.id || // my child
    from.parentId === to.id || // my parent
    (from.depth === 0 && to.depth === 0) // all roots are siblings
  if (!inFamily) throw new Error('A2A denied: recipient outside the nuclear family (parent/siblings/children only)')
  const msg = await db.agentMessage.create({ data: { fromId, toId, body, mode } })
  bus.emit({
    type: 'a2a:sent',
    source: 'agent',
    message: `${from.name} → ${to.name} (${mode}): ${body.slice(0, 80)}`,
    refId: msg.id,
  })
  return { broadcast: false, delivered: 1 }
}

/** Drain pending inbox messages into the transcript (turn boundary delivery). */
async function drainInbox(sessionId: string): Promise<string[]> {
  const pending = await db.agentMessage.findMany({
    where: { toId: sessionId, status: 'pending' },
    orderBy: { createdAt: 'asc' },
    take: 5,
    include: { from: { select: { name: true } } },
  })
  const injected: string[] = []
  for (const m of pending) {
    injected.push(`[message from ${m.from.name} · ${m.mode}]\n${m.body}`)
    await db.agentMessage.update({ where: { id: m.id }, data: { status: 'delivered' } })
  }
  return injected
}

// ── subagents ───────────────────────────────────────────────
const subagentSpawnSem = new Semaphore(12) // bounded concurrent subagent launches

export async function spawnSubagent(
  parentSessionId: string,
  name: string,
  prompt: string,
  model?: string
): Promise<string> {
  await subagentSpawnSem.acquire()
  try {
    const child = await createSession({ name, model, parentId: parentSessionId })
    // fire-and-forget: the child runs to completion in the background
    void runTurn(child.id, prompt, { actor: 'spawn' })
      .catch(async (e) => {
        await db.agentSession.update({
          where: { id: child.id },
          data: { status: 'error', lastMessage: String(e).slice(0, 500) },
        }).catch(() => null)
      })
      .finally(() => subagentSpawnSem.release())
    return child.id
  } catch (e) {
    subagentSpawnSem.release()
    throw e
  }
}

export async function collectSubagent(handle: string, timeoutSec = 120): Promise<{ status: string; result: string }> {
  const t0 = Date.now()
  for (;;) {
    const child = await db.agentSession.findUnique({ where: { id: handle } })
    if (!child) return { status: 'missing', result: 'no such subagent handle' }
    if (child.status === 'done' || child.status === 'error' || child.status === 'idle') {
      if (child.status === 'idle' && Date.now() - t0 < 2000) {
        // just spawned — not started yet
      } else {
        return { status: child.status, result: child.lastMessage || '(no output)' }
      }
    }
    if (Date.now() - t0 > timeoutSec * 1000) {
      return { status: 'timeout', result: child.lastMessage || '(still running)' }
    }
    await new Promise((r) => setTimeout(r, 1200))
  }
}

// ── code extraction ─────────────────────────────────────────
export function extractCode(text: string): { code: string | null; prose: string } {
  // strip label echoes from the model ("assistant code:", "python:", "observation:")
  const cleaned = text.replace(/^\s*(assistant code|python|code|observation)\s*:?\s*\n?/i, '')
  const fenced = cleaned.match(/```(?:python|py|bash)?\s*\n([\s\S]*?)```/)
  if (fenced) {
    const prose = cleaned.replace(fenced[0], '').trim()
    return { code: fenced[1].trim(), prose }
  }
  // unfenced code heuristic: whole message is code
  const first = cleaned.trim().split('\n')[0] ?? ''
  const codeish = /^(from |import |def |class |if |for |while |try:|with |x?\s*=|[a-zA-Z_][\w.]*\(|print\(|#\s|"""|'''|return |async )/.test(first)
  if (codeish) return { code: cleaned.trim(), prose: '' }
  return { code: null, prose: text }
}

// ── the turn engine ─────────────────────────────────────────
export interface RunTurnOpts {
  actor?: string // 'user' | 'spawn' | 'goal' | 'heartbeat' | 'gate' | 'autonomous' | 'factory'
  maxIterations?: number
  suppressEvents?: boolean
}

export interface TurnResult {
  final: string
  iterations: number
  done: boolean
  goalCompleted: boolean
  cancelled?: boolean
}

/**
 * Run one user turn on a session: append the user message, then
 * iterate code↔observation until flint_done or a prose answer.
 */
export async function runTurn(sessionId: string, userText: string, opts: RunTurnOpts = {}): Promise<TurnResult> {
  const session = await db.agentSession.findUnique({ where: { id: sessionId } })
  if (!session) throw new Error('session not found')

  const running = await db.agentSession.update({
    where: { id: sessionId },
    data: { status: 'running', lastActiveAt: new Date() },
  })
  bus.emit({
    type: 'session:turn',
    source: 'agent',
    message: `turn started on "${running.name}" (${opts.actor ?? 'user'})`,
    refId: sessionId,
  })

  // goal token accounting
  let goal: { id: string; tokenBudget: number; tokensUsed: number } | null = running.goalId
    ? await db.agentGoal.findUnique({ where: { id: running.goalId } })
    : null

  let maxIdx = (
    await db.sessionMessage.findFirst({ where: { sessionId }, orderBy: { idx: 'desc' }, select: { idx: true } })
  )?.idx ?? -1

  // append the user message
  await appendMessage(sessionId, ++maxIdx, 'user', opts.actor === 'spawn' ? 'spawn' : 'chat', userText)

  // per-turn state shared with host fns
  const turnState: { done: boolean; doneSummary: string; goalCompleted: boolean } = {
    done: false,
    doneSummary: '',
    goalCompleted: false,
  }

  const cwd = session.sandboxId
    ? (await db.sandbox.findUnique({ where: { id: session.sandboxId } }))?.workspacePath ?? undefined
    : undefined

  const maxIter = opts.maxIterations ?? MAX_TURNS_PER_REQUEST
  let iterations = 0
  let finalText = ''
  let cancelled = false
  // clear any stale cancel flag from a previous turn before starting
  clearTurnCancel(sessionId)

  try {
    const system = await systemPrompt(sessionId)
    for (let iter = 0; iter < maxIter; iter++) {
      // ACP session/cancel lands between iterations — bail cleanly
      if (isTurnCancelled(sessionId)) {
        cancelled = true
        break
      }
      iterations++
      // steer/follow-up inbox delivery at iteration boundary
      const inbox = await drainInbox(sessionId)
      if (inbox.length) {
        for (const m of inbox) await appendMessage(sessionId, ++maxIdx, 'user', 'a2a', m)
      }

      // build the LLM view — past assistant code is shown back as fenced
      // python (never labeled prose), observations as plain user turns
      const transcript = await transcriptFor(sessionId)
      const msgs: ChatMsg[] = [
        { role: 'system', content: system },
        ...transcript
          .filter((m) => m.role !== 'system' || m.kind === 'summary')
          .slice(-40)
          .map((m) => {
            if (m.role === 'assistant') {
              // assistant code turns are returned verbatim as fenced python
              if (m.kind === 'code') return { role: 'assistant' as const, content: '```python\n' + m.content + '\n```' }
              return { role: 'assistant' as const, content: m.content }
            }
            if (m.kind === 'stdout') return { role: 'user' as const, content: '```\n' + m.content + '\n```' }
            if (m.kind === 'summary') return { role: 'user' as const, content: m.content }
            return { role: 'user' as const, content: m.content }
          }),
      ]

      // auto-compaction check
      const est = msgs.reduce((a, m) => a + estTokens(m.content), 0)
      if (est > COMPACT_AT_TOKENS) {
        await compactSession(sessionId)
      }

      // final-iteration nudge: force a clean finish
      if (iter === maxIter - 1) {
        msgs.push({
          role: 'user',
          content:
            'FINAL ITERATION. If the task is complete, call flint_done(summary) with a concise summary of what was done and found. If it is genuinely incomplete, state exactly what is missing. Do not repeat verification.',
        })
      }

      const raw = await llmChat(msgs, { model: session.model, maxTokens: 1800 })
      const { code, prose } = extractCode(raw)

      // cost accounting
      const inText = msgs.map((m) => m.content).join('')
      const cost = modelCost(session.model, estTokens(inText), estTokens(raw))
      await db.agentSession.update({
        where: { id: sessionId },
        data: {
          tokensIn: { increment: estTokens(inText) },
          tokensOut: { increment: estTokens(raw) },
          costUsd: { increment: cost },
          turnCount: { increment: 1 },
        },
      })
      await db.usageEvent
        .create({ data: { sandboxId: session.sandboxId ?? 'agent-runtime', kind: 'agent-llm', seconds: 0, costUsd: cost } })
        .catch(() => null)
      if (goal) {
        goal = await db.agentGoal.update({
          where: { id: goal.id },
          data: { tokensUsed: { increment: estTokens(inText) + estTokens(raw) }, turnsUsed: { increment: 1 } },
        })
      }

      if (!code) {
        // prose answer = final
        await appendMessage(sessionId, ++maxIdx, 'assistant', 'chat', raw, {}, { tokensIn: estTokens(inText), tokensOut: estTokens(raw), costUsd: cost })
        finalText = raw
        break
      }

      // record assistant code
      await appendMessage(sessionId, ++maxIdx, 'assistant', 'code', code, {}, { tokensIn: estTokens(inText), tokensOut: estTokens(raw), costUsd: cost })
      bus.emit({
        type: 'session:code',
        source: 'agent',
        message: `${session.name} eval (${code.split('\n').length} lines)`,
        refId: sessionId,
        data: { sessionId, code: code.slice(0, 2000) },
      })

      // evaluate in the persistent kernel
      const result = await kernelManager.eval(sessionId, code, cwd)
      const observation = [
        result.ok ? '' : `⚠ kernel raised:\n${result.stderr.slice(-2000)}`,
        result.stdout.trim() ? `stdout:\n${result.stdout}` : '',
        result.stderr.trim() && result.ok ? `stderr:\n${result.stderr.slice(-1500)}` : '',
      ]
        .filter(Boolean)
        .join('\n') || '(no output)'
      await appendMessage(sessionId, ++maxIdx, 'tool', 'stdout', observation, {
        ok: result.ok,
        durationMs: result.durationMs,
      })
      bus.emit({
        type: 'session:stdout',
        source: 'agent',
        level: result.ok ? 'info' : 'warn',
        message: `kernel ${result.ok ? 'ok' : 'error'} · ${result.durationMs}ms: ${observation.slice(0, 120)}`,
        refId: sessionId,
        data: { sessionId, ok: result.ok, durationMs: result.durationMs, observation: observation.slice(0, 4000) },
      })

      // consume done / goal-complete signals raised by host fns during eval
      const flag = consumeDoneFlag(sessionId)
      if (flag.done || flag.goalCompleted) {
        turnState.done = true
        turnState.goalCompleted = flag.goalCompleted
        turnState.doneSummary = flag.summary || (flag.goalCompleted ? 'goal completed' : 'done')
        finalText = turnState.doneSummary
        await appendMessage(sessionId, ++maxIdx, 'assistant', 'chat', `**${finalText}**`)
        break
      }
    }

    if (cancelled) {
      const tailDesc = await db.sessionMessage.findMany({
        where: { sessionId },
        orderBy: { idx: 'desc' },
        take: 4,
      })
      const lastProse = tailDesc.find((m) => m.role === 'assistant' && m.kind === 'chat')
      finalText = lastProse?.content?.slice(0, 1200) || '(turn cancelled)'
      clearTurnCancel(sessionId)
    }

    if (!finalText) {
      // budget reached without flint_done — fall back to the last assistant
      // prose, else the last observation, so callers still get substance
      const tailDesc = await db.sessionMessage.findMany({
        where: { sessionId },
        orderBy: { idx: 'desc' },
        take: 6,
      })
      const tail = tailDesc.reverse() // oldest → newest
      const lastProse = [...tail].reverse().find((m) => m.role === 'assistant' && m.kind === 'chat')
      const lastObs = [...tail].reverse().find((m) => m.kind === 'stdout')
      finalText = lastProse?.content?.slice(0, 1500) || lastObs?.content?.slice(0, 800) || '(iteration budget reached)'
    }
    await db.agentSession.update({
      where: { id: sessionId },
      data: {
        status: turnState.goalCompleted ? 'idle' : 'done',
        lastMessage: finalText.slice(0, 2000),
        lastActiveAt: new Date(),
      },
    })
    // durable kernel state — snapshot to disk in the background (no latency)
    void kernelManager.snapshot(sessionId).catch(() => null)
    bus.emit({
      type: 'session:turn-done',
      source: 'agent',
      level: cancelled ? 'warn' : 'success',
      message: `turn ${cancelled ? 'cancelled' : 'done'} on "${session.name}": ${finalText.slice(0, 140)}`,
      refId: sessionId,
      data: { sessionId, cancelled, iterations, budgetReached: !cancelled && iterations >= maxIter, final: finalText.slice(0, 8000) },
    })
    return { final: finalText, iterations, done: turnState.done, goalCompleted: turnState.goalCompleted, cancelled }
  } catch (e) {
    await db.agentSession
      .update({ where: { id: sessionId }, data: { status: 'error', lastMessage: String(e).slice(0, 500), lastActiveAt: new Date() } })
      .catch(() => null)
    bus.emit({
      type: 'session:error',
      source: 'agent',
      level: 'error',
      message: `turn failed on "${session.name}": ${String(e).slice(0, 200)}`,
      refId: sessionId,
    })
    throw e
  }
}

// ── host function registry (the PTC tool surface) ───────────
export function registerRlmHostFunctions(): void {
  const H = kernelManager

  H.registerHostFn('websearch', async (_sid, args) => {
    const query = String(args[0] ?? '')
    const num = Math.max(1, Math.min(10, Number(args[1] ?? 5)))
    const z = await zai()
    const results = (await z.functions.invoke('web_search', { query, num })) as { name: string; url: string; snippet: string }[]
    return results.map((r, i) => `${i + 1}. ${r.name} (${r.url})\n   ${r.snippet}`).join('\n')
  })

  H.registerHostFn('done', async (sid, args) => {
    const summary = String(args[0] ?? '')
    const session = await db.agentSession.findUnique({ where: { id: sid } })
    if (session?.role === 'subagent' && summary) {
      await db.agentSession.update({ where: { id: sid }, data: { lastMessage: summary.slice(0, 2000), status: 'done' } }).catch(() => null)
    }
    // mark turn state via DB flag read by runTurn — simplest: store in global map
    doneFlags.set(sid, summary)
    return { done: true }
  })

  H.registerHostFn('spawn', async (sid, args) => {
    const name = String(args[0] ?? `subagent-${Date.now()}`)
    const prompt = String(args[1] ?? '')
    const model = args[2] ? String(args[2]) : undefined
    if (!prompt) throw new Error('spawn(name, prompt) requires a prompt')
    return spawnSubagent(sid, name, prompt, model)
  })

  H.registerHostFn('collect', async (_sid, args) => {
    const handle = String(args[0] ?? '')
    const timeout = Number(args[1] ?? 120)
    return collectSubagent(handle, timeout)
  })

  H.registerHostFn('progress_note', async (sid, args) => {
    const note = String(args[0] ?? '')
    const session = await db.agentSession.findUnique({ where: { id: sid } })
    if (session?.parentId) {
      await db.agentMessage.create({
        data: { fromId: sid, toId: session.parentId, body: `[progress] ${note}`, mode: 'follow-up' },
      })
    }
    bus.emit({
      type: 'a2a:progress',
      source: 'agent',
      message: `${session?.name ?? sid.slice(-6)} → parent: ${note.slice(0, 120)}`,
      refId: sid,
    })
    return { noted: true }
  })

  H.registerHostFn('list_agents', async (_sid) => {
    const sessions = await db.agentSession.findMany({
      where: { status: { not: 'archived' } },
      select: { id: true, name: true, role: true, depth: true, status: true, model: true, lastMessage: true, parentId: true },
      orderBy: { depth: 'asc' },
      take: 60,
    })
    return sessions.map((s) => ({
      id: s.id,
      name: s.name,
      role: s.role,
      depth: s.depth,
      status: s.status,
      model: s.model,
      parent: s.parentId?.slice(-6) ?? null,
      last: s.lastMessage.slice(0, 100),
    }))
  })

  H.registerHostFn('observe_agent', async (_sid, args) => {
    const id = String(args[0] ?? '')
    const target = await db.agentSession.findUnique({
      where: { id },
      include: { messages: { orderBy: { idx: 'desc' }, take: 6 } },
    })
    if (!target) throw new Error('no such agent')
    return {
      id: target.id,
      name: target.name,
      status: target.status,
      model: target.model,
      tokens: target.tokensIn + target.tokensOut,
      costUsd: Math.round(target.costUsd * 10000) / 10000,
      recent: target.messages.reverse().map((m) => `[${m.role}/${m.kind}] ${m.content.slice(0, 300)}`),
    }
  })

  H.registerHostFn('recent_messages', async (_sid) => {
    const msgs = await db.agentMessage.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { from: { select: { name: true } }, to: { select: { name: true } } },
    })
    return msgs.reverse().map((m) => `${m.from.name} → ${m.to.name ?? '*'} (${m.mode}): ${m.body.slice(0, 200)}`)
  })

  H.registerHostFn('send_message', async (sid, args) => {
    const to = String(args[0] ?? '')
    const body = String(args[1] ?? '')
    const mode = args[2] === 'steer' ? 'steer' : 'follow-up'
    if (!to || !body) throw new Error('send_message(to, body, mode?) requires to and body')
    return sendAgentMessage(sid, to, body, mode)
  })

  H.registerHostFn('mcp_list_tools', async (_sid, args) => {
    const server = args[0] ? String(args[0]) : undefined
    if (server) return mcpListTools(server)
    const servers = await mcpOverview()
    const out: Record<string, unknown> = {}
    for (const s of servers) {
      if (s.enabled) out[s.name] = await mcpListTools(s.name).catch((e) => [`error: ${String(e).slice(0, 150)}`])
    }
    return out
  })

  H.registerHostFn('mcp_call', async (_sid, args) => {
    const server = String(args[0] ?? '')
    const tool = String(args[1] ?? '')
    const toolArgs = (args[2] as Record<string, unknown>) ?? {}
    return mcpCallTool(server, tool, toolArgs)
  })

  H.registerHostFn('harness_list', async (_sid, args) => {
    const kind = args[0] ? String(args[0]) : undefined
    const items = await harnessList(kind)
    return items.map((i) => `${i.kind}/${i.name} (v${i.version}, used ${i.useCount}x): ${i.content.slice(0, 400)}`)
  })

  H.registerHostFn('harness_get', async (_sid, args) => {
    const { getItem } = await import('./harness')
    const item = await getItem(String(args[0] ?? ''), String(args[1] ?? ''))
    if (!item) throw new Error('no such harness item')
    await bumpUse(item.id)
    return { kind: item.kind, name: item.name, content: item.content, version: item.version }
  })

  H.registerHostFn('harness_upsert', async (_sid, args) => {
    const kind = String(args[0] ?? '')
    const name = String(args[1] ?? '')
    const content = String(args[2] ?? '')
    if (!kind || !name || !content) throw new Error('harness_upsert(kind, name, content)')
    const item = await harnessUpsert({ kind, name, content, actor: 'agent' })
    return { ok: true, id: item.id, version: item.version }
  })

  H.registerHostFn('compact_run', async (sid, args) => {
    const instructions = String(args[0] ?? '')
    return { compacted: await compactSession(sid, instructions) }
  })

  H.registerHostFn('goal_get', async (sid) => {
    const session = await db.agentSession.findUnique({ where: { id: sid }, include: { goals: { orderBy: { createdAt: 'desc' }, take: 1 } } })
    const goal = session?.goals[0]
    if (!goal || goal.status !== 'active') return { active: false }
    return { active: true, id: goal.id, objective: goal.objective, tokenBudget: goal.tokenBudget, tokensUsed: goal.tokensUsed }
  })

  H.registerHostFn('goal_complete', async (sid, args) => {
    const summary = String(args[0] ?? '')
    const session = await db.agentSession.findUnique({ where: { id: sid } })
    if (!session?.goalId) throw new Error('no active goal on this session')
    await db.agentGoal.update({
      where: { id: session.goalId },
      data: { status: 'complete', result: summary.slice(0, 4000), completedAt: new Date() },
    })
    await db.agentSession.update({ where: { id: sid }, data: { goalId: null } })
    goalDoneFlags.add(sid)
    bus.emit({
      type: 'goal:complete',
      source: 'agent',
      level: 'success',
      message: `goal complete on "${session.name}": ${summary.slice(0, 140)}`,
      refId: sid,
    })
    return { completed: true }
  })

  H.registerHostFn('factory_run', async (sid, args) => {
    const { runMachine } = await import('./factory')
    const slug = String(args[0] ?? '')
    const input = (args[1] as Record<string, unknown>) ?? {}
    return runMachine(slug, input, sid)
  })

  H.registerHostFn('metrics', async (sid) => {
    const session = await db.agentSession.findUnique({ where: { id: sid } })
    if (!session?.sandboxId) return { error: 'no sandbox attached' }
    const sbx = await db.sandbox.findUnique({ where: { id: session.sandboxId } })
    if (!sbx) return { error: 'sandbox not found' }
    const driver = getDriver(sbx.driver)
    return driver.metrics(
      { id: sbx.id, name: sbx.name, vcpu: sbx.vcpu, memoryGb: sbx.memoryGb, diskGb: sbx.diskGb, region: sbx.region },
      {
        startedAt: sbx.startedAt,
        lastActiveAt: sbx.lastActiveAt,
        execCount: counterState(sbx.id).execCount,
        bytesIO: counterState(sbx.id).bytesIO,
      }
    )
  })
}

// turn-state flags (kernel host fn → runTurn signaling)
const g = globalThis as unknown as {
  __flintDone?: Map<string, string>
  __flintGoalDone?: Set<string>
}
const doneFlags: Map<string, string> = g.__flintDone ?? (g.__flintDone = new Map())
const goalDoneFlags: Set<string> = g.__flintGoalDone ?? (g.__flintGoalDone = new Set())

// poll done flags inside runTurn's loop — patched in via below wrapper
export function consumeDoneFlag(sessionId: string): { done: boolean; summary: string; goalCompleted: boolean } {
  const summary = doneFlags.get(sessionId)
  const goalCompleted = goalDoneFlags.has(sessionId)
  if (summary !== undefined) doneFlags.delete(sessionId)
  goalDoneFlags.delete(sessionId)
  return { done: summary !== undefined, summary: summary ?? '', goalCompleted }
}
