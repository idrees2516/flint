// /api/flint/spaces — shared durable spaces (cross-agent state)
//   GET  → list known spaces (DB mirror) + default space info
//   POST body { slug } → ensure space + boot event
import { NextResponse } from 'next/server'
import { durable, safeActorName } from '@/lib/flint/durable'
import { bootDurableActors, spaceActor } from '@/lib/flint/actors'

export async function GET() {
  bootDurableActors()
  const { db } = await import('@/lib/db')
  const rows = await db.durableObject.findMany({
    where: { name: { startsWith: 'space:' } },
    orderBy: { lastActiveAt: 'desc' },
    take: 50,
  }).catch(() => [])
  const defaults = await spaceActor('flint-agents').info().catch(() => null)
  return NextResponse.json({
    spaces: rows.map((r) => ({ name: r.name, slug: r.name.replace(/^space:/, ''), stateVersion: r.stateVersion, lastActiveAt: r.lastActiveAt })),
    defaultSpace: defaults,
  })
}

export async function POST(req: Request) {
  bootDurableActors()
  const body = await req.json().catch(() => ({}))
  const slug = String(body.slug ?? '').trim().replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48)
  if (!slug) return NextResponse.json({ error: 'slug required' }, { status: 400 })
  const stub = spaceActor(slug)
  await stub.publish('boot', { created: true, at: Date.now() }, { from: 'api' })
  const info = await stub.info()
  return NextResponse.json({ ok: true, name: safeActorName('space', slug), info })
}
