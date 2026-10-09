import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { orchestrator } from '@/lib/flint/orchestrator'

export async function GET() {
  const sandboxes = await db.sandbox.findMany({
    include: { template: { select: { name: true, slug: true, icon: true } }, _count: { select: { snapshots: true, tasks: true } } },
    orderBy: { createdAt: 'desc' },
  })
  return NextResponse.json({ sandboxes })
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const name = String(body.name ?? `flint-${Math.random().toString(36).slice(2, 7)}`)
  const driver = body.driver === 'cloud-vm' ? 'cloud-vm' : 'local'
  const templateSlug = body.template ? String(body.template) : null
  const template = templateSlug ? await db.template.findUnique({ where: { slug: templateSlug } }) : null
  if (templateSlug && !template) return NextResponse.json({ error: 'unknown template' }, { status: 400 })

  const vcpu = Math.max(1, Math.min(32, Number(body.vcpu ?? 2)))
  const memoryGb = Math.max(1, Math.min(128, Number(body.memoryGb ?? 4)))
  const diskGb = Math.max(5, Math.min(512, Number(body.diskGb ?? 20)))

  const sandbox = await db.sandbox.create({
    data: {
      name,
      driver,
      region: String(body.region ?? 'us-east-1'),
      templateId: template?.id ?? null,
      vcpu,
      memoryGb,
      diskGb,
      hibernateAfterMin: Math.max(1, Math.min(1440, Number(body.hibernateAfterMin ?? 15))),
      status: 'provisioning',
    },
  })
  if (template) await db.template.update({ where: { id: template.id }, data: { launches: { increment: 1 } } })

  // provision in the background through the worker pool
  void orchestrator.submit(sandbox.id, 'start', 0).catch(() => {})

  return NextResponse.json({ sandbox, note: 'provisioning in background — watch it flip to running' })
}
