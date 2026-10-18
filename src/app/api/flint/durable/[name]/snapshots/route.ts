// /api/flint/durable/[name]/snapshots — versioned snapshots
//   GET  ?kind=state|kernel|mesh → list
//   POST body { op: "save", kind, blob, manifest } | { op: "restore", ref? }
import { NextRequest, NextResponse } from 'next/server'
import { durable } from '@/lib/flint/durable'
import { bootDurableActors } from '@/lib/flint/actors'

export async function GET(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params
  bootDurableActors()
  const kind = new URL(req.url).searchParams.get('kind') ?? undefined
  const snapshots = await durable.invoke(name, 'listSnapshots', [kind])
  return NextResponse.json({ name, snapshots })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params
  bootDurableActors()
  const body = await req.json().catch(() => ({}))
  const op = String(body.op ?? 'save')
  try {
    if (op === 'save') {
      const result = await durable.invoke(name, 'saveSnapshot', [
        String(body.kind ?? 'state'),
        typeof body.blob === 'string' ? body.blob : JSON.stringify(body.blob ?? {}),
        body.manifest ?? {},
      ])
      return NextResponse.json({ ok: true, snapshot: result })
    }
    if (op === 'restore') {
      const result = await durable.invoke(name, 'restoreCheckpoint', [body.ref ? String(body.ref) : undefined])
      return NextResponse.json({ ok: true, restore: result })
    }
    if (op === 'load') {
      const result = await durable.invoke(name, 'loadSnapshot', [String(body.ref ?? '')])
      if (!result) return NextResponse.json({ error: 'snapshot not found' }, { status: 404 })
      return NextResponse.json({ ok: true, snapshot: result })
    }
    return NextResponse.json({ error: 'op must be save | restore | load' }, { status: 400 })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 400 })
  }
}
