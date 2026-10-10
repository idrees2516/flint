import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSession } from '@/lib/flint/rlm'
import { kernelManager } from '@/lib/flint/kernel'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await getSession(id)
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const kernelVars = await kernelManager.vars(id).catch(() => ({}))
  return NextResponse.json({ session, kernelVars })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const data: Record<string, unknown> = {}
  if (body.name) data.name = String(body.name)
  if (body.model) data.model = String(body.model)
  if (body.thinkingLevel) data.thinkingLevel = String(body.thinkingLevel)
  if (body.sandboxId !== undefined) data.sandboxId = body.sandboxId ? String(body.sandboxId) : null
  const session = await db.agentSession.update({ where: { id }, data }).catch(() => null)
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ session })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await kernelManager.park(id).catch(() => null)
  await db.agentSession.update({ where: { id }, data: { status: 'archived' } }).catch(() => null)
  return NextResponse.json({ ok: true, note: 'kernel parked, session archived' })
}
