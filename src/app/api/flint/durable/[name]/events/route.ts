// /api/flint/durable/[name]/events — event-sourced log
//   GET  ?topic=&sinceSeq=&limit=
//   POST body { topic, payload, kind? } → append + broadcast
import { NextRequest, NextResponse } from 'next/server'
import { durable } from '@/lib/flint/durable'
import { bootDurableActors } from '@/lib/flint/actors'

export async function GET(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params
  bootDurableActors()
  const url = new URL(req.url)
  const topic = url.searchParams.get('topic') ?? undefined
  const sinceSeq = Number(url.searchParams.get('sinceSeq') ?? 0)
  const limit = Number(url.searchParams.get('limit') ?? 100)
  const events = await durable.invoke(name, 'listEvents', [{ topic, sinceSeq, limit }])
  return NextResponse.json({ name, events })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params
  bootDurableActors()
  const body = await req.json().catch(() => ({}))
  const topic = String(body.topic ?? 'log')
  const payload = body.payload ?? {}
  try {
    const evt = await durable.invoke(name, 'appendEvent', [topic, payload, String(body.kind ?? 'event')])
    return NextResponse.json({ ok: true, event: evt })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 400 })
  }
}
