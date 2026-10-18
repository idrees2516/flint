// POST /api/flint/durable/[name]/rpc — generic RPC into any durable actor
// body: { method: string, args?: unknown[] }
import { NextRequest, NextResponse } from 'next/server'
import { durable } from '@/lib/flint/durable'
import { bootDurableActors } from '@/lib/flint/actors'

export async function POST(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params
  bootDurableActors()
  const body = await req.json().catch(() => ({}))
  const method = String(body.method ?? '')
  const args = Array.isArray(body.args) ? body.args : []
  if (!method) return NextResponse.json({ error: 'method required' }, { status: 400 })
  try {
    const result = await durable.invoke(name, method, args)
    return NextResponse.json({ ok: true, name, method, result })
  } catch (err) {
    return NextResponse.json({ ok: false, name, method, error: err instanceof Error ? err.message : String(err) }, { status: 400 })
  }
}
