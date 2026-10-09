import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { cancelTask } from '@/lib/flint/agent'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const task = await db.agentTask.findUnique({
    where: { id },
    include: { steps: { orderBy: { idx: 'asc' } }, sandbox: { select: { id: true, name: true, status: true } } },
  })
  if (!task) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ task })
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  cancelTask(id)
  return NextResponse.json({ ok: true, note: 'cancellation requested — agent will stop at next checkpoint' })
}
