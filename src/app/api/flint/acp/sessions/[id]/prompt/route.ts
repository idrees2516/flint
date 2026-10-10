import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { admitPromptBlocks } from '@/lib/flint/acp'
import { runTurn } from '@/lib/flint/rlm'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// POST /api/flint/acp/sessions/[id]/prompt — ACP session/prompt.
// Body: { prompt: ContentBlock[] }. Runs one full turn (awaited) and
// returns the ACP stop reason. Progress streams over the connection's
// SSE channel as bus frames the adapter translates.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json().catch(() => ({}))

  const session = await db.agentSession.findUnique({ where: { id } })
  if (!session) return NextResponse.json({ error: 'session not found' }, { status: 404 })
  if (session.status === 'running') {
    return NextResponse.json({ error: 'session is busy — send session/cancel first' }, { status: 409 })
  }

  // admit prompt blocks (text · resource · resource_link — image rejected:
  // the RLM engine is text-first, so promptCapabilities.image = false)
  const admitted = admitPromptBlocks(body.prompt)
  if (!admitted.ok) return NextResponse.json({ error: admitted.error }, { status: 400 })
  if (admitted.prompt.imageCount > 0) {
    return NextResponse.json(
      { error: 'image blocks are not supported on this engine — Flint advertises promptCapabilities.image = false' },
      { status: 400 }
    )
  }

  try {
    const result = await runTurn(id, admitted.prompt.text, { actor: 'user' })
    const stopReason = result.cancelled
      ? 'cancelled'
      : result.final === '(iteration budget reached)'
        ? 'max_turn_requests'
        : 'end_turn'
    return NextResponse.json({
      stopReason,
      iterations: result.iterations,
      done: result.done,
      goalCompleted: result.goalCompleted,
      final: result.final.slice(0, 8000),
    })
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 400) }, { status: 500 })
  }
}
