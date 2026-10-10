import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { acp } from '@/lib/flint/acp'
import { createSession } from '@/lib/flint/rlm'
import { listModels, DEFAULT_MODEL } from '@/lib/flint/models'
import { upsertMcpServer } from '@/lib/flint/mcp'

export const dynamic = 'force-dynamic'

// POST /api/flint/acp/sessions — ACP session/new (cwd + mcpServers) and
// session/load ({ sessionId } adopts an existing Flint session).
// Auth: connectionId in body or X-Acp-Connection header.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const conn =
    acp.get(body.connectionId) ?? acp.get(req.headers.get('x-acp-connection'))
  if (!conn) return NextResponse.json({ error: 'unknown ACP connection — POST /api/flint/acp/connect first' }, { status: 400 })

  // ── session/load: adopt an existing session ────────────────
  if (body.sessionId) {
    const existing = await db.agentSession.findUnique({ where: { id: body.sessionId } })
    if (!existing) return NextResponse.json({ error: 'session not found' }, { status: 404 })
    if (existing.status === 'running') {
      return NextResponse.json({ error: 'session is busy' }, { status: 409 })
    }
    conn.registerSession({
      sessionId: existing.id,
      connectionId: conn.id,
      requestedCwd: typeof body.cwd === 'string' ? body.cwd : undefined,
      actualCwd: process.cwd(),
      mcpServers: Array.isArray(body.mcpServers) ? body.mcpServers : [],
      title: existing.name,
      model: existing.model,
      thinkingLevel: existing.thinkingLevel,
      promptTurnId: 0,
      createdAt: Date.now(),
    })
    return NextResponse.json({
      sessionId: existing.id,
      title: existing.name,
      loaded: true,
      cwd: { requested: body.cwd ?? null, actual: process.cwd() },
    })
  }

  // ── session/new: create a fresh RLM session ────────────────
  const cwd = typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : undefined
  const mcpServers: Array<Record<string, unknown>> = Array.isArray(body.mcpServers) ? body.mcpServers : []

  // client-declared HTTP MCP servers (editor-side) are registered into the
  // Flint catalog so their tools join the session's tool surface — parity
  // with prime-agent's ACP mcp.rs adapter surface
  const registered: string[] = []
  for (const s of mcpServers) {
    const name = typeof s?.name === 'string' ? s.name : null
    const url = typeof s?.url === 'string' ? s.url : null
    if (!name || !url) continue
    try {
      await upsertMcpServer({
        name: `acp:${name}`,
        transport: 'http',
        url,
        enabled: true,
      })
      registered.push(name)
    } catch {
      /* never fail session/new on a bad MCP declaration */
    }
  }

  const model = typeof body.model === 'string' && listModels().some((m) => m.id === body.model) ? body.model : DEFAULT_MODEL
  const title =
    typeof body.name === 'string' && body.name.trim()
      ? body.name.trim()
      : cwd
        ? `acp · ${cwd.split('/').filter(Boolean).pop() ?? cwd}`
        : `acp · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`

  const session = await createSession({ name: title, model, role: 'main' })
  conn.registerSession({
    sessionId: session.id,
    connectionId: conn.id,
    requestedCwd: cwd,
    actualCwd: process.cwd(),
    mcpServers,
    title,
    model: session.model,
    thinkingLevel: session.thinkingLevel,
    promptTurnId: 0,
    createdAt: Date.now(),
  })

  return NextResponse.json({
    sessionId: session.id,
    title,
    model: session.model,
    cwd: { requested: cwd ?? null, actual: process.cwd() },
    mcpRegistered: registered,
  })
}
