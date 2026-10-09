import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getDriver, bumpCounter } from '@/lib/flint/drivers'
import { orchestrator } from '@/lib/flint/orchestrator'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const cmd = String(body.cmd ?? '').trim()
  if (!cmd) return NextResponse.json({ error: 'cmd required' }, { status: 400 })

  const sandbox = await db.sandbox.findUnique({ where: { id }, include: { template: true } })
  if (!sandbox) return NextResponse.json({ error: 'not found' }, { status: 404 })

  // auto-resume hibernated/stopped sandboxes on exec — pay only for what you use
  if (sandbox.status !== 'running') {
    await orchestrator.submit(id, 'start', 0).catch(() => {})
    await db.sandbox.update({ where: { id }, data: { status: 'running' } })
  }

  const driver = getDriver(sandbox.driver)
  const spec = {
    id: sandbox.id,
    name: sandbox.name,
    templateSlug: sandbox.template?.slug,
    vcpu: sandbox.vcpu,
    memoryGb: sandbox.memoryGb,
    diskGb: sandbox.diskGb,
    region: sandbox.region,
  }
  const result = await driver.exec(spec, sandbox.workspacePath ?? process.cwd(), cmd, 15000)
  bumpCounter(id, result.stdout.length + result.stderr.length)
  orchestrator.touch(id)
  return NextResponse.json({ result })
}
