import { NextRequest, NextResponse } from 'next/server'
import { createHeartbeat, deleteHeartbeat, listHeartbeats, toggleHeartbeat, describeCron } from '@/lib/flint/heartbeats'

export async function GET() {
  const heartbeats = await listHeartbeats()
  return NextResponse.json({
    heartbeats: heartbeats.map((h) => ({ ...h, human: describeCron(h.cron) })),
  })
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const sessionId = String(body.sessionId ?? '')
  const name = String(body.name ?? '').trim()
  const cron = String(body.cron ?? '').trim()
  const prompt = String(body.prompt ?? '').trim()
  if (!sessionId || !name || !cron || !prompt) {
    return NextResponse.json({ error: 'sessionId, name, cron and prompt required' }, { status: 400 })
  }
  try {
    const hb = await createHeartbeat({
      sessionId,
      name,
      cron,
      prompt,
      mode: body.mode === 'steer' ? 'steer' : 'follow-up',
    })
    return NextResponse.json({ heartbeat: hb, human: describeCron(hb.cron) })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 })
  }
}

export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const id = String(body.id ?? '')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const hb = await toggleHeartbeat(id, Boolean(body.enabled))
  return NextResponse.json({ heartbeat: hb })
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id') ?? ''
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  await deleteHeartbeat(id)
  return NextResponse.json({ ok: true })
}
