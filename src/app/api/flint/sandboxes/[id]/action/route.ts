import { NextRequest, NextResponse } from 'next/server'
import { orchestrator } from '@/lib/flint/orchestrator'

const ACTIONS = new Set(['start', 'stop', 'hibernate', 'fork', 'snapshot'])

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const action = String(body.action ?? '')
  if (!ACTIONS.has(action)) return NextResponse.json({ error: `invalid action "${action}"` }, { status: 400 })

  // fork + snapshot return data — await them; start/stop/hibernate are fire-and-forget
  if (action === 'fork' || action === 'snapshot') {
    try {
      const result = await orchestrator.submit(id, action, 0, { name: body.name })
      return NextResponse.json({ ok: true, action, result })
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 500 })
    }
  }
  void orchestrator.submit(id, action, 0).catch(() => {})
  return NextResponse.json({ ok: true, action, note: `${action} dispatched to worker pool` })
}
