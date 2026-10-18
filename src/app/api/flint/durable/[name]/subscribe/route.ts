// GET /api/flint/durable/[name]/subscribe — SSE stream of state
// updates, events, alarms and snapshots (Agents-SDK onStateUpdate
// parity). Hibernation-safe: subscriptions live host-side.
import { NextRequest } from 'next/server'
import { durable } from '@/lib/flint/durable'
import { bootDurableActors } from '@/lib/flint/actors'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params
  bootDurableActors()
  const obj = durable.resolve(name)
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    start(controller) {
      let closed = false
      const send = (event: string, data: unknown) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch { closed = true }
      }
      // initial state snapshot
      void obj.invoke('stateSnapshot', []).then((state) => send('state', { objectName: name, state, ts: Date.now() })).catch(() => {})
      const unsubscribe = obj.subscribe((u) => send(u.type, u))
      const ping = setInterval(() => send('ping', { ts: Date.now() }), 20_000)
      if (ping.unref) ping.unref()
      // close hook: client disconnect
      const close = () => {
        if (closed) return
        closed = true
        clearInterval(ping)
        unsubscribe()
        try { controller.close() } catch { /* already closed */ }
      }
      // Next.js exposes abort on request; approximate cleanup via timer guard
      setTimeout(close, 10 * 60_000)
      if ((setTimeout as unknown as { unref?: unknown }).unref) { /* keep node process free */ }
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  })
}
