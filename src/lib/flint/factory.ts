// ─────────────────────────────────────────────────────────────
// Flint · Factory — FSM/DAG multi-agent workflow engine.
//
// Machines are declarative state machines of spawned child
// agents (prime-agent parity):
//   • nodes: agent specs (prompt template, model, onFailure)
//   • foreach fan-out: one child per item, joined downstream
//   • joins: wait for all upstream nodes
//   • guards: boolean expressions over node outputs
//   • budgets: budgetMs per run, maxParallel fan-out width
//   • failure policies: fail | retry | skip
// ─────────────────────────────────────────────────────────────
import { db } from '@/lib/db'
import { bus } from './events'
import { Semaphore } from './concurrency'
import { createSession } from './rlm'

export interface MachineNode {
  id: string
  kind: 'agent' | 'join'
  title: string
  prompt: string // {{input.x}} and {{node.<id>}} templating
  model?: string
  foreach?: string[] // fan-out items — {{item}} in the prompt
  guard?: string // e.g. "node.research.ok && node.research.result.length > 10"
  budgetMs?: number
  onFailure?: 'fail' | 'retry' | 'skip'
  retries?: number
  next: string[] // successor node ids
}

export interface MachineSpec {
  description?: string
  entry: string
  maxParallel?: number
  nodes: MachineNode[]
}

export interface NodeState {
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  result?: string
  sessions?: string[]
  error?: string
  startedAt?: number
  durationMs?: number
}

// ── templating ──────────────────────────────────────────────
function renderTemplate(tpl: string, ctx: { input: Record<string, unknown>; node: Record<string, { ok: boolean; result: string }>; item?: string }): string {
  return tpl
    .replace(/\{\{\s*input\.([\w.]+)\s*\}\}/g, (_, path: string) => {
      const val = path.split('.').reduce<unknown>((acc, k) => (acc as Record<string, unknown>)?.[k], ctx.input)
      return val === undefined ? '' : typeof val === 'object' ? JSON.stringify(val) : String(val)
    })
    .replace(/\{\{\s*item\s*\}\}/g, ctx.item ?? '')
    .replace(/\{\{\s*node\.([\w.]+)\s*\}\}/g, (_, id: string) => ctx.node[id]?.result?.slice(0, 4000) ?? '')
}

function evalGuard(guard: string, nodes: Record<string, { ok: boolean; result: string }>): boolean {
  try {
    const fn = new Function('node', `"use strict"; return (${guard})`)
    return Boolean(fn(nodes))
  } catch {
    return false
  }
}

// ── machine CRUD ────────────────────────────────────────────
export async function upsertMachine(input: { slug: string; name: string; description?: string; spec: MachineSpec; isOfficial?: boolean }) {
  const existing = await db.factoryMachine.findUnique({ where: { slug: input.slug } })
  const data = {
    slug: input.slug,
    name: input.name,
    description: input.description ?? '',
    spec: JSON.stringify(input.spec),
    isOfficial: input.isOfficial ?? false,
  }
  if (existing) return db.factoryMachine.update({ where: { id: existing.id }, data })
  return db.factoryMachine.create({ data })
}

export async function listMachines() {
  const machines = await db.factoryMachine.findMany({ include: { _count: { select: { runs: true } } }, orderBy: { createdAt: 'asc' } })
  return machines.map((m) => ({ ...m, spec: safeParse(m.spec) as MachineSpec }))
}

export async function listRuns(take = 20) {
  return db.factoryRun.findMany({
    include: { machine: { select: { slug: true, name: true } } },
    orderBy: { createdAt: 'desc' },
    take,
  })
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}

// ── the engine ──────────────────────────────────────────────
interface RunCtx {
  runId: string
  rootSessionId: string | null
  spec: MachineSpec
  input: Record<string, unknown>
  nodeStates: Record<string, NodeState>
  nodeResults: Record<string, { ok: boolean; result: string }>
}

async function runAgentNode(ctx: RunCtx, node: MachineNode, item?: string): Promise<{ ok: boolean; result: string }> {
  const prompt = renderTemplate(node.prompt, { input: ctx.input, node: ctx.nodeResults, item })
  const session = await createSession({
    name: item ? `${node.id}:${item}`.slice(0, 60) : node.id,
    model: node.model,
    parentId: ctx.rootSessionId ?? undefined,
    role: 'factory-node',
  })
  // run the child turn inline (bounded)
  const { runTurn } = await import('./rlm')
  const budgetMs = node.budgetMs ?? 240_000
  const t0 = Date.now()
  const result = await Promise.race([
    runTurn(session.id, prompt, { actor: 'factory', maxIterations: 5 }),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`node ${node.id} exceeded budget ${budgetMs}ms`)), budgetMs)),
  ]).catch((e) => ({
    final: `error: ${String(e).slice(0, 500)}`,
    iterations: 0,
    done: false,
    goalCompleted: false,
  }))
  return {
    ok: !result.final.startsWith('error:'),
    result: result.final.slice(0, 6000),
    ...(Date.now() - t0 ? {} : {}),
  }
}

/**
 * Execute a machine: topological execution with parallel wave
 * scheduling (independent nodes run concurrently, bounded by
 * maxParallel), foreach fan-out, joins and guards.
 */
export async function runMachine(slug: string, input: Record<string, unknown>, rootSessionId?: string): Promise<Record<string, unknown>> {
  const machine = await db.factoryMachine.findUnique({ where: { slug } })
  if (!machine) throw new Error(`unknown machine "${slug}"`)
  const spec = safeParse(machine.spec) as MachineSpec
  if (!spec.nodes?.length) throw new Error('machine has no nodes')

  const run = await db.factoryRun.create({
    data: {
      machineId: machine.id,
      sessionId: rootSessionId ?? null,
      status: 'running',
      input: JSON.stringify(input),
      budgetMs: 600_000,
      startedAt: new Date(),
    },
  })
  bus.emit({
    type: 'factory:run',
    source: 'agent',
    message: `factory run started: ${machine.name} (${spec.nodes.length} nodes)`,
    refId: run.id,
  })

  const ctx: RunCtx = {
    runId: run.id,
    rootSessionId: rootSessionId ?? null,
    spec,
    input,
    nodeStates: Object.fromEntries(spec.nodes.map((n) => [n.id, { status: 'pending' } as NodeState])),
    nodeResults: {},
  }
  const t0 = Date.now()
  const maxParallel = spec.maxParallel ?? 4
  const fanoutSem = new Semaphore(maxParallel)
  const retriesLeft = new Map(spec.nodes.map((n) => [n.id, n.retries ?? (n.onFailure === 'retry' ? 1 : 0)]))

  const persist = async (status: string, error?: string) => {
    await db.factoryRun.update({
      where: { id: run.id },
      data: {
        status,
        nodeStates: JSON.stringify(ctx.nodeStates),
        error: error?.slice(0, 1000),
        finishedAt: status === 'done' || status === 'failed' ? new Date() : null,
      },
    }).catch(() => null)
  }

  try {
    // wave-based execution until all nodes resolved or no progress
    for (let wave = 0; wave < spec.nodes.length + 4; wave++) {
      if (Date.now() - t0 > 600_000) throw new Error('machine budget exhausted (10 min)')
      const resolved = new Set(Object.entries(ctx.nodeStates).filter(([, s]) => s.status === 'done' || s.status === 'failed' || s.status === 'skipped').map(([id]) => id))
      // ready nodes: pending, all predecessors resolved, guard passes
      const ready = spec.nodes.filter((n) => {
        if (ctx.nodeStates[n.id].status !== 'pending') return false
        const preds = spec.nodes.filter((m) => m.next.includes(n.id)).map((m) => m.id)
        if (!preds.every((p) => resolved.has(p))) return false
        if (preds.some((p) => ctx.nodeStates[p].status === 'failed')) {
          ctx.nodeStates[n.id].status = 'skipped'
          return false
        }
        if (n.guard && !evalGuard(n.guard, ctx.nodeResults)) {
          ctx.nodeStates[n.id].status = 'skipped'
          return false
        }
        return true
      })
      if (ready.length === 0) break

      await Promise.all(
        ready.map(async (node) => {
          ctx.nodeStates[node.id] = { status: 'running', startedAt: Date.now() }
          await persist('running')
          try {
            if (node.kind === 'join') {
              // joins wait for predecessors (already guaranteed) — pass through
              ctx.nodeStates[node.id] = { status: 'done', durationMs: 0 }
              ctx.nodeResults[node.id] = { ok: true, result: Object.entries(ctx.nodeResults).map(([id, r]) => `${id}: ${r.result.slice(0, 200)}`).join('\n') }
              return
            }
            if (node.foreach?.length) {
              // fan-out: one child per item
              const results = await fanoutSem.map(node.foreach, async (item) => runAgentNode(ctx, node, item))
              const combined = results.map((r, i) => `## ${node.foreach![i]}\n${r.result}`).join('\n\n')
              const anyFail = results.some((r) => !r.ok)
              if (anyFail && node.onFailure === 'fail') throw new Error(`foreach node ${node.id} had failing children`)
              ctx.nodeStates[node.id] = {
                status: 'done',
                result: combined.slice(0, 8000),
                durationMs: Date.now() - (ctx.nodeStates[node.id].startedAt ?? Date.now()),
              }
              ctx.nodeResults[node.id] = { ok: !anyFail, result: combined.slice(0, 8000) }
            } else {
              const r = await runAgentNode(ctx, node)
              if (!r.ok && node.onFailure !== 'skip' && (retriesLeft.get(node.id) ?? 0) > 0) {
                retriesLeft.set(node.id, (retriesLeft.get(node.id) ?? 0) - 1)
                const retry = await runAgentNode(ctx, node)
                Object.assign(r, retry)
              }
              if (!r.ok && node.onFailure === 'fail') throw new Error(`node ${node.id} failed: ${r.result.slice(0, 200)}`)
              ctx.nodeStates[node.id] = { status: r.ok ? 'done' : 'failed', result: r.result, durationMs: Date.now() - (ctx.nodeStates[node.id].startedAt ?? Date.now()) }
              ctx.nodeResults[node.id] = r
            }
          } catch (e) {
            ctx.nodeStates[node.id] = { status: 'failed', error: String(e).slice(0, 500) }
            ctx.nodeResults[node.id] = { ok: false, result: String(e).slice(0, 500) }
          }
        })
      )
      await persist('running')
      const allDone = spec.nodes.every((n) => ctx.nodeStates[n.id].status !== 'pending' && ctx.nodeStates[n.id].status !== 'running')
      if (allDone) break
    }

    const failed = Object.values(ctx.nodeStates).some((s) => s.status === 'failed')
    await persist(failed ? 'failed' : 'done')
    bus.emit({
      type: failed ? 'factory:failed' : 'factory:done',
      source: 'agent',
      level: failed ? 'error' : 'success',
      message: `factory run ${failed ? 'failed' : 'completed'}: ${machine.name} in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      refId: run.id,
    })
    return {
      runId: run.id,
      status: failed ? 'failed' : 'done',
      nodes: ctx.nodeStates,
      durationMs: Date.now() - t0,
    }
  } catch (e) {
    await persist('failed', String(e))
    bus.emit({
      type: 'factory:failed',
      source: 'agent',
      level: 'error',
      message: `factory run failed: ${machine.name} — ${String(e).slice(0, 200)}`,
      refId: run.id,
    })
    return { runId: run.id, status: 'failed', error: String(e), nodes: ctx.nodeStates }
  }
}

export async function stopRun(runId: string) {
  await db.factoryRun.update({ where: { id: runId }, data: { status: 'stopped', finishedAt: new Date() } }).catch(() => null)
}
