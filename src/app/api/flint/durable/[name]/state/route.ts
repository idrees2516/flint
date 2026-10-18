// /api/flint/durable/[name]/state — durable actor state
//   GET    → { state, version, meta }
//   PATCH  → body { patch } → setState (persist + broadcast)
//   DELETE → body { keys: [] } → remove state keys
import { NextRequest, NextResponse } from 'next/server'
import { durable } from '@/lib/flint/durable'
import { bootDurableActors } from '@/lib/flint/actors'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params
  bootDurableActors()
  const obj = durable.resolve(name)
  const state = await obj.invoke<Record<string, unknown>>('stateSnapshot', [])
  return NextResponse.json({ name, state, meta: obj.meta() })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params
  bootDurableActors()
  const body = await req.json().catch(() => ({}))
  const patch = (body.patch ?? body) as Record<string, unknown>
  try {
    const version = await durable.invoke<number>(name, 'publishState', [patch], name.startsWith('agent:') ? 'AgentActor' : undefined)
    return NextResponse.json({ ok: true, name, version })
  } catch (err) {
    // non-agent actors don't expose publishState — fall back to direct KV setState
    const obj = durable.resolve(name)
    for (const [k, v] of Object.entries(patch)) await obj.invoke('_durable_set', [k, v]).catch(() => {})
    return NextResponse.json({ ok: true, name, note: 'kv-mode' })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params
  bootDurableActors()
  const body = await req.json().catch(() => ({}))
  const keys = Array.isArray(body.keys) ? body.keys.map(String) : []
  const obj = durable.resolve(name)
  for (const k of keys) await obj.invoke('_durable_delete', [k]).catch(() => {})
  return NextResponse.json({ ok: true, deleted: keys })
}
