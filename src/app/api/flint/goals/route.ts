import { NextRequest, NextResponse } from 'next/server'
import { createGoal, driveGoal, listGoals, cancelGoal } from '@/lib/flint/goals'

export async function GET(req: NextRequest) {
  const status = req.nextUrl.searchParams.get('status') ?? undefined
  const goals = await listGoals(status)
  return NextResponse.json({ goals })
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const sessionId = String(body.sessionId ?? '')
  const objective = String(body.objective ?? '').trim()
  if (!sessionId || !objective) return NextResponse.json({ error: 'sessionId and objective required' }, { status: 400 })
  const goal = await createGoal(sessionId, objective, Math.max(1000, Number(body.tokenBudget ?? 80_000)))
  if (body.drive !== false) {
    void driveGoal(goal.id).catch((e) => console.error('[flint:goal]', e))
  }
  return NextResponse.json({ goal, driving: body.drive !== false })
}

export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const id = String(body.id ?? '')
  const action = String(body.action ?? '')
  if (action === 'cancel') {
    await cancelGoal(id)
    return NextResponse.json({ ok: true })
  }
  if (action === 'drive') {
    void driveGoal(id).catch(() => null)
    return NextResponse.json({ ok: true, driving: true })
  }
  return NextResponse.json({ error: 'unknown action' }, { status: 400 })
}
