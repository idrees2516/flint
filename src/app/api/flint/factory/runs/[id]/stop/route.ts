import { NextRequest, NextResponse } from 'next/server'
import { stopRun } from '@/lib/flint/factory'

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await stopRun(id)
  return NextResponse.json({ ok: true })
}
