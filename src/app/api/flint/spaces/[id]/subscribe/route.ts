// GET /api/flint/spaces/[id]/subscribe — SSE watch on a shared
// space: live publishes + KV changes (?topic= filters; ?sinceSeq=
// replays history first)
import { NextRequest } from 'next/server'
import { durable } from '@/lib/flint/durable'
import { bootDurableActors, spaceActor } from '@/lib/flint/actors'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  bootDurableActors()
  const url = new URL(req.url)
  const topic = url.searchParams.get('topic') ?? undefined
  const sinceSeq = Number(url.searchParams.get('sinceSeq') ?? 0)

  const name = `space:${id.replace(/^space:/, '')}`
  const obj = durable.resolve(name, 'SpaceActor')
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    start(controller) {
      let closed = false
      const send = (event: string, data: unknown) => {
        if (closed) return
        try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) } catch { closed = true }
      }
      // replay history first
      void obj.invoke('listEvents', [{ topic, sinceSeq, limit: 50 }]).then((events) => {
        for (const e of (events as Array<Record<string, unknown>>).reverse()) send('event', e)
      }).catch(() => {})
      const unsubscribe = obj.subscribe((u) => {
        if (topic && u.event && u.event.topic !== topic) return
        send(u.type === 'event' ? 'event' : 'state', u)
      })
      const ping = setInterval(() => send('ping', { ts: Date.now() }), 20_000)
      if (ping.unref) ping.unref()
      setTimeout(() => {
        if (closed) return
        closed = true
        clearInterval(ping)
        unsubscribe()
        try { controller.close() } catch { /* noop */ }
      }, 10 * 60_000)
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
