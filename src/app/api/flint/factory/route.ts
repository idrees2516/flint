import { NextRequest, NextResponse } from 'next/server'
import { listMachines, listRuns, upsertMachine, type MachineSpec } from '@/lib/flint/factory'

export async function GET() {
  const [machines, runs] = await Promise.all([listMachines(), listRuns()])
  return NextResponse.json({ machines, runs })
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const slug = String(body.slug ?? '').trim()
  const name = String(body.name ?? '').trim()
  const spec = body.spec as MachineSpec | undefined
  if (!slug || !name || !spec?.nodes?.length) {
    return NextResponse.json({ error: 'slug, name and spec.nodes required' }, { status: 400 })
  }
  const machine = await upsertMachine({
    slug,
    name,
    description: body.description ? String(body.description) : '',
    spec,
    isOfficial: false,
  })
  return NextResponse.json({ machine })
}
