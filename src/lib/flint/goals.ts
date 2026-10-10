// ─────────────────────────────────────────────────────────────
// Flint · Goals + Autonomous Mode (prime-agent parity)
//
// Goals: persistent objectives with token budgets. The harness
// keeps re-prompting the session across turns until the agent
// calls goal_complete() or the budget is exhausted.
//
// Autonomous mode: bounded continuation with turn/token/time
// budgets and user-defined COMPLETION GATES — arbitrary shell
// commands that must pass before the run may finish. Failed
// gate output is fed back to the agent for another attempt.
// ─────────────────────────────────────────────────────────────
import { db } from '@/lib/db'
import { bus } from './events'
import { runTurn, appendMessage, consumeDoneFlag } from './rlm'
import { kernelManager } from './kernel'

// ── goals ───────────────────────────────────────────────────
export async function createGoal(sessionId: string, objective: string, tokenBudget = 80_000) {
  const goal = await db.agentGoal.create({
    data: { sessionId, objective, tokenBudget, status: 'active' },
  })
  await db.agentSession.update({ where: { id: sessionId }, data: { goalId: goal.id } })
  bus.emit({
    type: 'goal:created',
    source: 'agent',
    level: 'success',
    message: `goal set: "${objective.slice(0, 120)}" (budget ${tokenBudget.toLocaleString()} tokens)`,
    refId: sessionId,
  })
  return goal
}

export async function listGoals(status?: string) {
  return db.agentGoal.findMany({
    where: status ? { status } : {},
    include: { session: { select: { id: true, name: true, model: true } } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
}

export async function cancelGoal(goalId: string) {
  await db.agentGoal.update({ where: { id: goalId }, data: { status: 'cancelled' } }).catch(() => null)
  const goal = await db.agentGoal.findUnique({ where: { id: goalId } })
  if (goal) await db.agentSession.update({ where: { id: goal.sessionId }, data: { goalId: null } }).catch(() => null)
}

/**
 * Goal driver — the continuation loop. Runs turns until the
 * agent completes the goal or the token budget runs out.
 */
export async function driveGoal(goalId: string): Promise<{ status: string; result: string; turns: number }> {
  const goal = await db.agentGoal.findUnique({ where: { id: goalId }, include: { session: true } })
  if (!goal || goal.status !== 'active') return { status: goal?.status ?? 'missing', result: goal?.result ?? '', turns: 0 }
  const sessionId = goal.sessionId
  let turns = 0
  for (let i = 0; i < 40; i++) {
    const g = await db.agentGoal.findUnique({ where: { id: goalId } })
    if (!g || g.status !== 'active') break
    if (g.tokensUsed >= g.tokenBudget) {
      await db.agentGoal.update({ where: { id: goalId }, data: { status: 'exhausted' } })
      await db.agentSession.update({ where: { id: sessionId }, data: { goalId: null } })
      bus.emit({
        type: 'goal:exhausted',
        source: 'agent',
        level: 'warn',
        message: `goal budget exhausted (${g.tokenBudget.toLocaleString()} tokens) — stopping`,
        refId: sessionId,
      })
      break
    }
    const prompt =
      turns === 0
        ? `GOAL: ${g.objective}\n\nWork toward this goal now. Use your kernel aggressively (parallel bash handles, subagents). Call host("goal_complete", summary) when it is fully achieved.`
        : `Continue driving toward the goal (tokens used ${g.tokensUsed.toLocaleString()}/${g.tokenBudget.toLocaleString()}). Do not repeat finished work — your kernel state persists. Finish with host("goal_complete", summary) when done.`
    const result = await runTurn(sessionId, prompt, { actor: 'goal', maxIterations: 6 })
    turns += result.iterations
    if (result.goalCompleted) break
    if (result.done) {
      // the agent finished via flint_done — treat as goal completion
      await db.agentGoal.update({ where: { id: goalId }, data: { status: 'complete', result: result.final.slice(0, 4000), completedAt: new Date() } }).catch(() => null)
      await db.agentSession.update({ where: { id: sessionId }, data: { goalId: null } }).catch(() => null)
      bus.emit({
        type: 'goal:complete',
        source: 'agent',
        level: 'success',
        message: `goal completed (via flint_done): ${result.final.slice(0, 120)}`,
        refId: sessionId,
      })
      break
    }
    consumeDoneFlag(sessionId) // clear any stale flags
  }
  const final = await db.agentGoal.findUnique({ where: { id: goalId } })
  return { status: final?.status ?? 'unknown', result: final?.result ?? '', turns }
}

// ── autonomous mode with gates ──────────────────────────────
export interface AutonomousOpts {
  objective: string
  maxTurns?: number // default 12
  maxTokens?: number // default 80000
  timeoutMs?: number // default 30 min
  gates?: string[] // shell commands that must exit 0
  gateRetries?: number // default 3
  continuePrompt?: string // how to ask for another attempt
}

export interface AutonomousResult {
  status: 'done' | 'gates-failed' | 'budget' | 'timeout' | 'error'
  turns: number
  tokensUsed: number
  final: string
  gates: Array<{ cmd: string; passed: boolean; output: string; attempts: number }>
}

/**
 * Autonomous runner: bounded continuation with completion gates.
 * After each turn the gates run (in the session's kernel cwd);
 * failing gate output is returned to the agent for repair.
 */
export async function runAutonomous(sessionId: string, opts: AutonomousOpts): Promise<AutonomousResult> {
  const session = await db.agentSession.findUnique({ where: { id: sessionId } })
  if (!session) throw new Error('session not found')
  const maxTurns = opts.maxTurns ?? 12
  const maxTokens = opts.maxTokens ?? 80_000
  const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000
  const gates = opts.gates ?? []
  const gateRetries = opts.gateRetries ?? 3
  const t0 = Date.now()
  let tokensUsed = 0
  let turns = 0
  const gateLog: AutonomousResult['gates'] = gates.map((cmd) => ({ cmd, passed: false, output: '', attempts: 0 }))

  bus.emit({
    type: 'autonomous:started',
    source: 'agent',
    message: `autonomous run on "${session.name}": ${maxTurns} turns · ${maxTokens.toLocaleString()} tokens · ${gates.length} gate(s)`,
    refId: sessionId,
  })

  const objectiveMsg =
    `AUTONOMOUS OBJECTIVE: ${opts.objective}\n\n` +
    (gates.length
      ? `COMPLETION GATES (shell commands that must pass before you finish):\n${gates.map((g) => `- ${g}`).join('\n')}\n`
      : '') +
    `Work autonomously. Prefer writing code/tests to talking. ` +
    `When you believe the objective is met${gates.length ? ' AND the gates will pass' : ''}, call flint_done(summary).`

  let lastResult = ''
  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      if (Date.now() - t0 > timeoutMs) {
        return { status: 'timeout', turns, tokensUsed, final: lastResult, gates: gateLog }
      }
      const msg = turn === 0 ? objectiveMsg : opts.continuePrompt ?? 'Continue the autonomous objective. Verify your work with real commands, then finish with flint_done(summary) when the gates pass.'
      const result = await runTurn(sessionId, msg, { actor: 'autonomous', maxIterations: 6 })
      turns += result.iterations
      tokensUsed = (await db.agentSession.findUnique({ where: { id: sessionId } }))?.tokensIn ?? tokensUsed
      lastResult = result.final
      if (tokensUsed > maxTokens) {
        bus.emit({
          type: 'autonomous:budget',
          source: 'agent',
          level: 'warn',
          message: `autonomous run hit token budget (${tokensUsed.toLocaleString()})`,
          refId: sessionId,
        })
        return { status: 'budget', turns, tokensUsed, final: lastResult, gates: gateLog }
      }
      if (result.done || result.goalCompleted) {
        // run the gates
        if (gates.length === 0) {
          return { status: 'done', turns, tokensUsed, final: lastResult, gates: gateLog }
        }
        let allPassed = true
        for (let gi = 0; gi < gates.length; gi++) {
          const gate = gates[gi]
          const entry = gateLog[gi]
          entry.attempts++
          const res = await kernelManager.eval(sessionId, `bash(${JSON.stringify(gate)}).output(60)`)
          entry.output = (res.stdout + res.stderr).slice(0, 2000)
          entry.passed = res.ok && !/\[exit ([1-9]|1[0-9]*)/.test(entry.output)
          if (!entry.passed) allPassed = false
        }
        await appendMessage(
          sessionId,
          (await db.sessionMessage.count({ where: { sessionId } })),
          'user',
          'gate',
          `GATE RESULTS:\n${gateLog.map((g) => `${g.passed ? '✓ PASS' : '✗ FAIL'} · ${g.cmd}\n${g.passed ? '' : g.output.slice(0, 800)}`).join('\n\n')}`
        )
        if (allPassed) {
          bus.emit({
            type: 'autonomous:done',
            source: 'agent',
            level: 'success',
            message: `autonomous run passed ${gates.length}/${gates.length} gates in ${turns} iterations`,
            refId: sessionId,
          })
          return { status: 'done', turns, tokensUsed, final: lastResult, gates: gateLog }
        }
        const exhausted = gateLog.every((g) => g.attempts >= gateRetries)
        if (exhausted) {
          return { status: 'gates-failed', turns, tokensUsed, final: lastResult, gates: gateLog }
        }
        // feed failures back — loop continues with the continue prompt
        bus.emit({
          type: 'autonomous:gate-failed',
          source: 'agent',
          level: 'warn',
          message: `gates failed (${gateLog.filter((g) => !g.passed).length} pending) — feeding output back to agent`,
          refId: sessionId,
        })
      }
    }
    return { status: 'budget', turns, tokensUsed, final: lastResult, gates: gateLog }
  } catch (e) {
    return { status: 'error', turns, tokensUsed, final: String(e), gates: gateLog }
  }
}
