import { NextRequest, NextResponse } from 'next/server'
import { runAutonomous } from '@/lib/flint/goals'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const objective = String(body.objective ?? '').trim()
  if (!objective) return NextResponse.json({ error: 'objective required' }, { status: 400 })
  const gates = Array.isArray(body.gates) ? body.gates.map(String).filter(Boolean).slice(0, 6) : []

  // fire-and-forget — status streams over the event bus
  void runAutonomous(id, {
    objective,
    gates,
    maxTurns: Math.max(1, Math.min(40, Number(body.maxTurns ?? 12))),
    maxTokens: Math.max(1000, Number(body.maxTokens ?? 80_000)),
    timeoutMs: Math.max(30_000, Number(body.timeoutMs ?? 30 * 60 * 1000)),
    gateRetries: Math.max(1, Math.min(6, Number(body.gateRetries ?? 3))),
  }).catch((e) => console.error('[flint:autonomous]', e))

  return NextResponse.json({ ok: true, note: 'autonomous run started', gates })
}
