// ─────────────────────────────────────────────────────────────
// Flint · Event Bus — in-process pub/sub fanned out to the
// realtime mini-service (socket.io) and persisted to EventLog.
// Publishes are non-blocking; DB writes are batched.
// ─────────────────────────────────────────────────────────────
import { BatchWriter } from './concurrency'

export type FlintEvent = {
  type:
    | 'sandbox:provisioning'
    | 'sandbox:running'
    | 'sandbox:stopped'
    | 'sandbox:hibernated'
    | 'sandbox:error'
    | 'sandbox:destroyed'
    | 'sandbox:forked'
    | 'snapshot:created'
    | 'task:queued'
    | 'task:running'
    | 'task:step'
    | 'task:done'
    | 'task:failed'
    | 'billing:tick'
    | 'billing:alert'
    | 'fleet:metric'
    // RLM session engine (prime-agent parity)
    | 'session:created'
    | 'session:turn'
    | 'session:turn-done'
    | 'session:code'
    | 'session:stdout'
    | 'session:compacted'
    | 'session:error'
    | 'kernel:restarted'
    | 'kernel:evicted'
    | 'a2a:sent'
    | 'a2a:progress'
    | 'goal:created'
    | 'goal:complete'
    | 'goal:exhausted'
    | 'heartbeat:created'
    | 'heartbeat:fired'
    | 'harness:updated'
    | 'harness:refine'
    | 'factory:run'
    | 'factory:done'
    | 'factory:failed'
    | 'autonomous:started'
    | 'autonomous:done'
    | 'autonomous:budget'
    | 'autonomous:gate-failed'
    // ACP transport (editor bridge)
    | 'acp:connected'
    | 'acp:closed'
    // Durable runtime (Cloudflare Durable Objects architecture)
    | 'durable:state'
    | 'durable:alarm'
    | 'durable:event'
    | 'space:published'
    // Stateless sandbox mesh (E2B / Daytona / InstaBox / Docker / GH-Actions / Jupyter)
    | 'mesh:task'
    | 'mesh:sandbox'
    | 'mesh:provider'
  level?: 'info' | 'warn' | 'error' | 'success'
  source?: 'fleet' | 'sandbox' | 'agent' | 'billing' | 'api'
  message: string
  refId?: string
  data?: Record<string, unknown>
  ts?: number
}

type Handler = (e: FlintEvent) => void

const REALTIME_URL = process.env.FLINT_REALTIME_URL || 'http://127.0.0.1:3004'
const EVENT_TTL_PERSIST = new Set<FlintEvent['type']>([
  'sandbox:running',
  'sandbox:stopped',
  'sandbox:hibernated',
  'sandbox:destroyed',
  'sandbox:forked',
  'snapshot:created',
  'task:done',
  'task:failed',
  'billing:alert',
])

class EventBus {
  private handlers = new Set<Handler>()
  private persistBuffer = new BatchWriter<{ level: string; source: string; message: string; refId?: string }>(
    async (batch) => {
      const { db } = await import('@/lib/db')
      await db.eventLog.createMany({ data: batch }).catch(() => {})
    },
    40,
    1500
  )

  on(h: Handler): () => void {
    this.handlers.add(h)
    return () => this.handlers.delete(h)
  }

  emit(e: FlintEvent): void {
    const event: FlintEvent = { ...e, ts: Date.now() }
    // fan-out to local subscribers (SSE, in-process listeners)
    for (const h of this.handlers) {
      try {
        h(event)
      } catch {
        /* isolate handler failures */
      }
    }
    // forward to realtime mini-service (socket.io gateway)
    void fetch(`${REALTIME_URL}/internal/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(2000),
    }).catch(() => {
      /* realtime service optional */
    })
    // persist selected events (batched)
    if (EVENT_TTL_PERSIST.has(event.type)) {
      this.persistBuffer.add({
        level: event.level ?? 'info',
        source: event.source ?? 'fleet',
        message: event.message,
        refId: event.refId,
      })
    }
  }
}

const g = globalThis as unknown as { __flintBus?: EventBus }
export const bus: EventBus = g.__flintBus ?? (g.__flintBus = new EventBus())
