import { NextRequest, NextResponse } from 'next/server'
import { sendAgentMessage } from '@/lib/flint/rlm'

/** A2A messaging — `prime-agent send` equivalent. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const fromId = String(body.fromId ?? '')
  const toId = String(body.toId ?? '')
  const bodyText = String(body.body ?? '')
  if (!fromId || !toId || !bodyText) {
    return NextResponse.json({ error: 'fromId, toId and body required' }, { status: 400 })
  }
  try {
    const result = await sendAgentMessage(fromId, toId, bodyText, body.mode === 'steer' ? 'steer' : 'follow-up')
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 403 })
  }
}
