import { NextRequest, NextResponse } from 'next/server'
import { acp } from '@/lib/flint/acp'

export const dynamic = 'force-dynamic'

// POST /api/flint/acp/connect — open an ACP connection (one per adapter
// process). Body: { clientInfo?: { name, version } } → { connectionId }
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const conn = acp.createConnection(body.clientInfo)
  return NextResponse.json({ connectionId: conn.id })
}

// GET /api/flint/acp/connect?id=<connectionId> — SSE stream of bus frames
// for every session the connection tracks. The adapter translates these
// into ACP session/update notifications.
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id')
  const conn = acp.get(id)
  if (!conn) return NextResponse.json({ error: 'unknown connection' }, { status: 404 })

  const encoder = new TextEncoder()
  let unsubscribe: (() => void) | null = null
  let ping: ReturnType<typeof setInterval> | null = null

  const stream = new ReadableStream({
    start(controller) {
      const send = (payload: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
          conn.framesSent++
        } catch {
          /* stream closed */
        }
      }
      // replay: hello frame so the adapter can confirm the wire
      send({ type: 'acp:hello', connectionId: conn.id, ts: Date.now() })
      unsubscribe = conn.subscribe((frame) => send(frame))
      ping = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`))
          conn.touch()
        } catch {
          /* closed */
        }
      }, 20_000)
      req.signal.addEventListener('abort', () => {
        unsubscribe?.()
        if (ping) clearInterval(ping)
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      })
    },
    cancel() {
      unsubscribe?.()
      if (ping) clearInterval(ping)
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}

// DELETE /api/flint/acp/connect?id=<connectionId> — tear the connection down
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id')
  if (!id || !acp.get(id)) return NextResponse.json({ error: 'unknown connection' }, { status: 404 })
  acp.close(id)
  return NextResponse.json({ ok: true })
}
