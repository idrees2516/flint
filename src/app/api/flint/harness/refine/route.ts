import { NextRequest, NextResponse } from 'next/server'
import { applyRefinement, planRefinements, rollbackRefinement } from '@/lib/flint/harness'

/**
 * POST /api/flint/harness/refine
 *   { evidence, sessionId?, maxEdits? }               → plan refinements
 *   { refinementId, action: "apply" | "rollback" }    → apply/rollback
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  try {
    if (body.refinementId) {
      const id = String(body.refinementId)
      if (body.action === 'rollback') {
        await rollbackRefinement(id)
        return NextResponse.json({ ok: true, rolledBack: true })
      }
      await applyRefinement(id)
      return NextResponse.json({ ok: true, applied: true })
    }
    const planned = await planRefinements(String(body.evidence ?? ''), {
      sessionId: body.sessionId ? String(body.sessionId) : undefined,
      maxEdits: body.maxEdits ? Number(body.maxEdits) : undefined,
    })
    return NextResponse.json({ planned })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 })
  }
}
