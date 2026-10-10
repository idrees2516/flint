import { NextRequest, NextResponse } from 'next/server'
import { forkSession } from '@/lib/flint/rlm'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  try {
    const fork = await forkSession(id, body.name ? String(body.name) : undefined)
    return NextResponse.json({ session: fork })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 })
  }
}
