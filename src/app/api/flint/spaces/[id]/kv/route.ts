// /api/flint/spaces/[id]/kv — shared durable KV (LWW registers)
//   GET  ?key=&prefix= → entry or list
//   POST body { key, value } → put (versioned)
//   DELETE ?key= → delete
import { NextRequest, NextResponse } from 'next/server'
import { bootDurableActors, spaceActor } from '@/lib/flint/actors'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  bootDurableActors()
  const url = new URL(req.url)
  const key = url.searchParams.get('key')
  const prefix = url.searchParams.get('prefix')
  const stub = spaceActor(id)
  if (key) {
    const entry = await stub.kvGet(key)
    return NextResponse.json({ entry })
  }
  const entries = await stub.kvList(prefix ?? undefined)
  return NextResponse.json({ entries })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  bootDurableActors()
  const body = await req.json().catch(() => ({}))
  const key = String(body.key ?? '')
  if (!key) return NextResponse.json({ error: 'key required' }, { status: 400 })
  const entry = await spaceActor(id).kvPut(key, body.value ?? null, String(body.by ?? 'api'))
  return NextResponse.json({ ok: true, entry })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  bootDurableActors()
  const key = new URL(req.url).searchParams.get('key') ?? ''
  const deleted = await spaceActor(id).kvDelete(key)
  return NextResponse.json({ ok: true, deleted })
}
