import { NextRequest, NextResponse } from 'next/server'
import { compactSession } from '@/lib/flint/rlm'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const compacted = await compactSession(id, String(body.instructions ?? ''))
  return NextResponse.json({ compacted })
}
