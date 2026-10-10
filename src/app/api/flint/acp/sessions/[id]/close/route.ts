import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { acp } from '@/lib/flint/acp'
import { kernelManager } from '@/lib/flint/kernel'

export const dynamic = 'force-dynamic'

// POST /api/flint/acp/sessions/[id]/close — ACP session/close.
// Parks the kernel (state is snapshotted to disk — resumable), marks the
// session idle and drops it from the owning connection.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await db.agentSession.findUnique({ where: { id } })
  if (!session) return NextResponse.json({ error: 'session not found' }, { status: 404 })

  // park the kernel — durable snapshot survives, idle eviction resumes lazily
  await kernelManager.park(id).catch(() => null)
  await db.agentSession
    .update({ where: { id }, data: { status: 'idle', lastActiveAt: new Date() } })
    .catch(() => null)

  // detach from whichever connection tracked it
  const conn = acp.connectionFor(id)
  if (conn) {
    conn.sessions.delete(id)
    if (conn.sessions.size === 0) {
      // last session gone — keep the connection itself open (client decides)
      conn.touch()
    }
  }
  return NextResponse.json({ ok: true, closed: id })
}
