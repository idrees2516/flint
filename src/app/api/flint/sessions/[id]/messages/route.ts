import { NextRequest, NextResponse } from 'next/server'
import { runTurn } from '@/lib/flint/rlm'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const text = String(body.text ?? body.prompt ?? '').trim()
  if (!text) return NextResponse.json({ error: 'text required' }, { status: 400 })
  const session = await (await import('@/lib/db')).db.agentSession.findUnique({ where: { id } })
  if (!session) return NextResponse.json({ error: 'session not found' }, { status: 404 })
  if (session.status === 'running') {
    return NextResponse.json({ error: 'session is busy — message queued via A2A instead', busy: true }, { status: 409 })
  }
  // fire-and-forget — progress streams over the event bus + transcript polling
  void runTurn(id, text, { actor: 'user' }).catch((e) => console.error('[flint:rlm]', e))
  return NextResponse.json({ ok: true, note: 'turn started — poll transcript or listen on socket' })
}
