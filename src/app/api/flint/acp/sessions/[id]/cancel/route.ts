import { NextRequest, NextResponse } from 'next/server'
import { requestTurnCancel } from '@/lib/flint/acp'

export const dynamic = 'force-dynamic'

// POST /api/flint/acp/sessions/[id]/cancel — ACP session/cancel.
// Flags the running turn; runTurn lands the cancellation at the next
// iteration boundary and reports stopReason = "cancelled".
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  requestTurnCancel(id)
  return NextResponse.json({ ok: true, cancelled: id })
}
