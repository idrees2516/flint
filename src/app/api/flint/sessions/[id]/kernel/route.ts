import { NextRequest, NextResponse } from 'next/server'
import { kernelManager } from '@/lib/flint/kernel'
import { db } from '@/lib/db'

/** Direct kernel eval — the UI's interactive REPL panel. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const code = String(body.code ?? '')
  if (!code.trim()) return NextResponse.json({ error: 'code required' }, { status: 400 })
  const session = await db.agentSession.findUnique({ where: { id } })
  if (!session) return NextResponse.json({ error: 'session not found' }, { status: 404 })
  const cwd = session.sandboxId
    ? (await db.sandbox.findUnique({ where: { id: session.sandboxId } }))?.workspacePath ?? undefined
    : undefined
  const result = await kernelManager.eval(id, code, cwd, Number(body.timeoutMs ?? 60_000))
  return NextResponse.json({ result })
}

/** Live kernel variables. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const vars = await kernelManager.vars(id).catch(() => ({}))
  const snapshot = await kernelManager.snapshot(id).catch(() => null)
  return NextResponse.json({
    vars,
    snapshotMeta: snapshot
      ? { vars: Object.keys(snapshot.manifest).length, totalBytes: Object.values(snapshot.manifest).reduce((a, m) => a + (m.bytes ?? 0), 0) }
      : null,
    stats: kernelManager.stats(),
  })
}
