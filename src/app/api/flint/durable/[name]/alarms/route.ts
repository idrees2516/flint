// /api/flint/durable/[name]/alarms — durable alarms
//   GET    → { alarmAt }
//   POST   body { atMs | delayMs, prompt?, mode?, cron? } → schedule wake-up (agents) or raw alarm
//   DELETE → cancel alarm + wake-up config
import { NextRequest, NextResponse } from 'next/server'
import { durable } from '@/lib/flint/durable'
import { bootDurableActors } from '@/lib/flint/actors'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params
  bootDurableActors()
  const alarmAt = await durable.invoke<number | null>(name, 'getAlarm', [])
  let wakeUp: unknown = null
  if (name.startsWith('agent:')) {
    wakeUp = await durable.invoke(name, 'wakeUpInfo', [], 'AgentActor').catch(() => null)
  }
  return NextResponse.json({ name, alarmAt, wakeUp })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params
  bootDurableActors()
  const body = await req.json().catch(() => ({}))
  try {
    if (name.startsWith('agent:') && body.prompt) {
      // AgentActor wake-up: fires a real turn when the alarm rings
      const r = await durable.invoke(name, 'scheduleWakeUp', [{
        atMs: body.atMs ? Number(body.atMs) : undefined,
        delayMs: body.delayMs ? Number(body.delayMs) : undefined,
        prompt: String(body.prompt),
        mode: body.mode === 'note' ? 'note' : 'turn',
        cron: body.cron ? String(body.cron) : undefined,
      }], 'AgentActor')
      return NextResponse.json({ ok: true, at: r })
    }
    // raw alarm — fires the actor's alarm() handler
    const at = body.atMs ? Number(body.atMs) : Date.now() + Number(body.delayMs ?? 60_000)
    await durable.invoke(name, 'setAlarm', [at])
    return NextResponse.json({ ok: true, at })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 400 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params
  bootDurableActors()
  if (name.startsWith('agent:')) {
    await durable.invoke(name, 'cancelWakeUp', [], 'AgentActor').catch(() => null)
  }
  await durable.invoke(name, 'setAlarm', [null]).catch(() => null)
  return NextResponse.json({ ok: true })
}
