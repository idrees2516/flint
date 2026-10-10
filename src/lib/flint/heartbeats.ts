// ─────────────────────────────────────────────────────────────
// Flint · Heartbeats — cron-scheduled agent prompts.
//
// User-level (`/heartbeat` equivalent) and agent-level triggers:
//   • 5-field cron expressions (min hour dom month dow)
//   • steer | follow-up delivery modes
//   • the scheduler ticks every 30s and fires due heartbeats
//     as turn prompts on their sessions
// ─────────────────────────────────────────────────────────────
import { db } from '@/lib/db'
import { bus } from './events'
import { runTurn } from './rlm'

// ── minimal cron engine (5-field) ───────────────────────────
interface CronField {
  min: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
}

function parseField(spec: string, min: number, max: number): Set<number> {
  const out = new Set<number>()
  for (const part of spec.split(',')) {
    const [range, stepRaw] = part.split('/')
    const step = stepRaw ? parseInt(stepRaw, 10) : 1
    let lo = min
    let hi = max
    if (range !== '*' && range !== '') {
      if (range.includes('-')) {
        const [a, b] = range.split('-').map((n) => parseInt(n, 10))
        lo = a
        hi = b
      } else {
        lo = hi = parseInt(range, 10)
      }
    }
    if (Number.isNaN(lo) || Number.isNaN(hi) || Number.isNaN(step) || step < 1) throw new Error(`bad cron field: ${part}`)
    for (let v = lo; v <= hi; v += step) {
      const wrapped = ((v - min) + (max - min + 1)) % (max - min + 1) + min
      out.add(wrapped)
    }
  }
  return out
}

export function parseCron(expr: string): CronField {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error('cron must have 5 fields: min hour dom month dow')
  return {
    min: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    dom: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12),
    dow: parseField(parts[4], 0, 6),
  }
}

export function nextFire(expr: string, from = new Date()): Date {
  const f = parseCron(expr)
  const t = new Date(from.getTime() + 60_000)
  t.setSeconds(0, 0)
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (
      f.min.has(t.getMinutes()) &&
      f.hour.has(t.getHours()) &&
      f.dom.has(t.getDate()) &&
      f.month.has(t.getMonth() + 1) &&
      f.dow.has(t.getDay())
    ) {
      return new Date(t)
    }
    t.setMinutes(t.getMinutes() + 1)
  }
  throw new Error('no fire time within a year')
}

export function describeCron(expr: string): string {
  try {
    const next = nextFire(expr)
    return `next fire: ${next.toISOString().replace('T', ' ').slice(0, 16)}Z`
  } catch {
    return 'invalid cron'
  }
}

// ── CRUD ────────────────────────────────────────────────────
export async function createHeartbeat(input: { sessionId: string; name: string; cron: string; prompt: string; mode?: string }) {
  parseCron(input.cron) // validate
  const hb = await db.heartbeat.create({
    data: {
      sessionId: input.sessionId,
      name: input.name,
      cron: input.cron,
      prompt: input.prompt,
      mode: input.mode === 'steer' ? 'steer' : 'follow-up',
      nextFireAt: nextFire(input.cron),
    },
  })
  bus.emit({
    type: 'heartbeat:created',
    source: 'agent',
    message: `heartbeat "${hb.name}" · ${hb.cron} (${hb.mode}) — ${describeCron(hb.cron)}`,
    refId: hb.sessionId,
  })
  return hb
}

export async function listHeartbeats() {
  return db.heartbeat.findMany({
    include: { session: { select: { id: true, name: true, status: true } } },
    orderBy: { createdAt: 'desc' },
  })
}

export async function toggleHeartbeat(id: string, enabled: boolean) {
  const hb = await db.heartbeat.findUnique({ where: { id } })
  if (!hb) throw new Error('heartbeat not found')
  return db.heartbeat.update({
    where: { id },
    data: { enabled, nextFireAt: enabled ? nextFire(hb.cron) : null },
  })
}

export async function deleteHeartbeat(id: string) {
  await db.heartbeat.delete({ where: { id } }).catch(() => null)
}

// ── scheduler ───────────────────────────────────────────────
class HeartbeatScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  running = false
  fired = 0

  start(): void {
    if (this.running) return
    this.running = true
    this.timer = setInterval(() => void this.tick(), 30_000)
    console.log('[flint:heartbeats] scheduler online — 30s tick')
  }

  private async tick(): Promise<void> {
    try {
      const due = await db.heartbeat.findMany({
        where: { enabled: true, nextFireAt: { lte: new Date() } },
        include: { session: true },
        take: 20,
      })
      for (const hb of due) {
        if (hb.session.status === 'running') {
          // don't stack turns on a busy session — reschedule
          await db.heartbeat.update({ where: { id: hb.id }, data: { nextFireAt: nextFire(hb.cron) } })
          continue
        }
        this.fired++
        await db.heartbeat.update({
          where: { id: hb.id },
          data: { lastFiredAt: new Date(), nextFireAt: nextFire(hb.cron), fireCount: { increment: 1 } },
        })
        bus.emit({
          type: 'heartbeat:fired',
          source: 'agent',
          message: `heartbeat "${hb.name}" fired on "${hb.session.name}" (${hb.mode})`,
          refId: hb.sessionId,
        })
        void runTurn(hb.sessionId, `[heartbeat ${hb.name}]\n${hb.prompt}`, { actor: 'heartbeat', maxIterations: 4 }).catch(() => null)
      }
    } catch {
      /* scheduler must never throw */
    }
  }
}

const g = globalThis as unknown as { __flintHeartbeats?: HeartbeatScheduler }
export const heartbeatScheduler: HeartbeatScheduler = g.__flintHeartbeats ?? (g.__flintHeartbeats = new HeartbeatScheduler())
export function bootHeartbeats(): void {
  heartbeatScheduler.start()
}
