import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { fleetMetricsFor } from '@/lib/flint/metrics'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const sandbox = await db.sandbox.findUnique({
    where: { id },
    include: {
      template: true,
      snapshots: { orderBy: { createdAt: 'desc' } },
      tasks: { orderBy: { createdAt: 'desc' }, take: 5 },
    },
  })
  if (!sandbox) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const metrics = sandbox.status === 'running' ? await fleetMetricsFor(id).catch(() => null) : null
  return NextResponse.json({ sandbox, metrics })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { orchestrator } = await import('@/lib/flint/orchestrator')
  void orchestrator.submit(id, 'delete', 0).catch(() => {})
  return NextResponse.json({ ok: true, note: 'destroying in background' })
}
