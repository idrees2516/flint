// POST /api/flint/spaces/[id]/publish — publish to a shared space
// body { topic, payload, from? }  → persisted event + live fan-out
import { NextRequest, NextResponse } from 'next/server'
import { bootDurableActors, spaceActor } from '@/lib/flint/actors'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  bootDurableActors()
  const body = await req.json().catch(() => ({}))
  const topic = String(body.topic ?? 'general')
  if (!topic) return NextResponse.json({ error: 'topic required' }, { status: 400 })
  const r = await spaceActor(id).publish(topic, body.payload ?? {}, { from: String(body.from ?? 'api') })
  return NextResponse.json({ ok: true, seq: r.seq, topic: r.topic, space: id })
}
