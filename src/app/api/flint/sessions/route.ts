import { NextRequest, NextResponse } from 'next/server'
import { createSession, listSessions } from '@/lib/flint/rlm'

export async function GET(req: NextRequest) {
  const role = req.nextUrl.searchParams.get('role') ?? undefined
  const sessions = await listSessions(role)
  return NextResponse.json({ sessions })
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const name = String(body.name ?? '').trim()
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })
  const session = await createSession({
    name,
    model: body.model ? String(body.model) : undefined,
    thinkingLevel: body.thinkingLevel ? String(body.thinkingLevel) : undefined,
    sandboxId: body.sandboxId ? String(body.sandboxId) : null,
  })
  return NextResponse.json({ session })
}
