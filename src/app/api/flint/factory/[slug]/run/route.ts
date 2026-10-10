import { NextRequest, NextResponse } from 'next/server'
import { runMachine } from '@/lib/flint/factory'

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const body = await req.json().catch(() => ({}))
  try {
    const result = await runMachine(slug, (body.input as Record<string, unknown>) ?? {}, body.sessionId ? String(body.sessionId) : undefined)
    return NextResponse.json({ result })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 })
  }
}
