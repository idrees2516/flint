import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { acp, configOptionsFor } from '@/lib/flint/acp'
import { listModels } from '@/lib/flint/models'

export const dynamic = 'force-dynamic'

async function optionsFor(sessionId: string) {
  const session = await db.agentSession.findUnique({ where: { id: sessionId } })
  if (!session) return null
  return configOptionsFor({
    model: session.model,
    thinkingLevel: session.thinkingLevel,
    models: listModels().map((m) => ({ id: m.id, name: m.name, thinking: m.thinking })),
  })
}

// GET /api/flint/acp/sessions/[id]/config — the session's config options
// (model · thought_level) — parity with pa-daemon's config_option surface.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const options = await optionsFor(id)
  if (!options) return NextResponse.json({ error: 'session not found' }, { status: 404 })
  return NextResponse.json({ sessionId: id, configOptions: options })
}

// POST /api/flint/acp/sessions/[id]/config — ACP session/set_config_option.
// Body: { id: 'model' | 'thought_level', value: string }
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const optionId = String(body.id ?? '')
  const value = String(body.value ?? '')

  const session = await db.agentSession.findUnique({ where: { id } })
  if (!session) return NextResponse.json({ error: 'session not found' }, { status: 404 })
  if (session.status === 'running') {
    return NextResponse.json({ error: 'cannot switch config mid-turn — cancel first' }, { status: 409 })
  }

  if (optionId === 'model') {
    if (!listModels().some((m) => m.id === value)) return NextResponse.json({ error: `unknown model "${value}"` }, { status: 400 })
    await db.agentSession.update({ where: { id }, data: { model: value } })
  } else if (optionId === 'thought_level') {
    if (!['off', 'low', 'medium', 'high'].includes(value)) {
      return NextResponse.json({ error: `unknown thought level "${value}"` }, { status: 400 })
    }
    await db.agentSession.update({ where: { id }, data: { thinkingLevel: value } })
  } else {
    return NextResponse.json({ error: `unknown config option "${optionId}"` }, { status: 400 })
  }

  // refresh the connection's record so status stays truthful
  const conn = acp.connectionFor(id)
  if (conn) {
    const rec = conn.sessions.get(id)
    if (rec) {
      if (optionId === 'model') rec.model = value
      else rec.thinkingLevel = value
    }
  }

  const options = await optionsFor(id)
  return NextResponse.json({ sessionId: id, configOptions: options })
}
