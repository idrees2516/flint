// ─────────────────────────────────────────────────────────────
// Flint · ACP bridge (Agent Client Protocol parity with
// prime-agent's pa-daemon ACP surface).
//
// The ACP adapter (scripts/flint-acp.mjs) speaks ndjson JSON-RPC
// 2.0 on stdio to an editor (Zed / Neovim) and bridges to the
// Flint server over HTTP. This module is the server half:
//   - connection registry (one per adapter process)
//   - per-connection frame queues fed from the event bus,
//     drained by the SSE endpoint (`GET /api/flint/acp/connect`)
//   - ACP session records (cwd / mcpServers / config options)
//   - turn-cancellation registry consumed by runTurn
//   - config-option surface (model · thought_level) served to
//     `session/set_config_option` — parity with pa-daemon's
//     config_options.rs
// ─────────────────────────────────────────────────────────────
import type { FlintEvent } from './events'
import { bus } from './events'

export const ACP_META_NAMESPACE = 'ai.flint.agent'
export const ACP_PROTOCOL_VERSION = 1

// ── ACP session record ──────────────────────────────────────
export interface AcpSessionRecord {
  /** Flint AgentSession id — doubles as the ACP session id */
  sessionId: string
  connectionId: string
  /** cwd the client requested (session/new) */
  requestedCwd?: string
  /** cwd the runtime actually uses (sandbox workspace or server cwd) */
  actualCwd: string
  /** MCP servers the client declared on session/new */
  mcpServers: unknown[]
  title: string
  model: string
  thinkingLevel: string
  promptTurnId: number
  createdAt: number
}

export interface AcpFrame {
  /** the bus event, forwarded verbatim for the adapter to translate */
  event: FlintEvent
  /** correlation: the flint session this frame belongs to */
  sessionId: string
  seq: number
}

type FrameListener = (f: AcpFrame) => void

export class AcpConnection {
  id: string
  createdAt = Date.now()
  lastSeenAt = Date.now()
  clientInfo?: { name?: string; version?: string }
  sessions = new Map<string, AcpSessionRecord>()
  promptTurns = 0
  framesSent = 0

  private buffer: AcpFrame[] = []
  private listeners = new Set<FrameListener>()
  private seq = 0

  constructor(id: string) {
    this.id = id
  }

  touch() {
    this.lastSeenAt = Date.now()
  }

  registerSession(record: AcpSessionRecord) {
    this.sessions.set(record.sessionId, record)
  }

  /** route a bus event to this connection's queue (filtered upstream) */
  offer(event: FlintEvent, sessionId: string) {
    const frame: AcpFrame = { event, sessionId, seq: ++this.seq }
    if (this.listeners.size === 0) {
      this.buffer.push(frame)
      if (this.buffer.length > 512) this.buffer.splice(0, this.buffer.length - 512)
      return
    }
    for (const l of this.listeners) {
      try {
        l(frame)
      } catch {
        /* isolate listener failures */
      }
    }
  }

  /** subscribe live; replays buffered frames first (delivered pre-SSE) */
  subscribe(l: FrameListener): () => void {
    for (const f of this.buffer.splice(0)) {
      try {
        l(f)
      } catch {
        /* drain best-effort */
      }
    }
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  nextPromptTurnId(): number {
    return ++this.promptTurns
  }

  describe() {
    return {
      id: this.id,
      createdAt: this.createdAt,
      lastSeenAt: this.lastSeenAt,
      client: this.clientInfo,
      sessions: [...this.sessions.values()].map((s) => ({
        sessionId: s.sessionId,
        title: s.title,
        model: s.model,
        thinkingLevel: s.thinkingLevel,
        cwd: s.requestedCwd,
        mcpServers: s.mcpServers.length,
        promptTurns: s.promptTurnId,
      })),
    }
  }
}

// ── manager (process-wide singleton) ────────────────────────
class AcpManager {
  connections = new Map<string, AcpConnection>()
  private sweeper: ReturnType<typeof setInterval> | null = null

  constructor() {
    // fan bus events out to every connection tracking the refId session
    bus.on((e) => {
      if (this.connections.size === 0) return
      const sid = e.refId
      if (!sid) return
      for (const conn of this.connections.values()) {
        if (conn.sessions.has(sid)) conn.offer(e, sid)
      }
    })
  }

  createConnection(clientInfo?: { name?: string; version?: string }): AcpConnection {
    const id = 'acp_' + Math.random().toString(36).slice(2, 10)
    const conn = new AcpConnection(id)
    if (clientInfo) conn.clientInfo = clientInfo
    this.connections.set(id, conn)
    bus.emit({
      type: 'acp:connected',
      source: 'api',
      message: `ACP connection ${id} opened${clientInfo?.name ? ` (${clientInfo.name})` : ''}`,
      refId: id,
      data: { connectionId: id },
    })
    this.ensureSweeper()
    return conn
  }

  get(id: string | null | undefined): AcpConnection | null {
    if (!id) return null
    const conn = this.connections.get(id)
    conn?.touch()
    return conn ?? null
  }

  close(id: string) {
    const conn = this.connections.get(id)
    if (!conn) return
    this.connections.delete(id)
    bus.emit({
      type: 'acp:closed',
      source: 'api',
      message: `ACP connection ${id} closed (${conn.sessions.size} session${conn.sessions.size === 1 ? '' : 's'})`,
      refId: id,
      data: { connectionId: id, framesSent: conn.framesSent },
    })
  }

  /** the connection that owns a session, if any */
  connectionFor(sessionId: string): AcpConnection | null {
    for (const conn of this.connections.values()) {
      if (conn.sessions.has(sessionId)) return conn
    }
    return null
  }

  status() {
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      metaNamespace: ACP_META_NAMESPACE,
      adapter: {
        command: 'node scripts/flint-acp.mjs',
        transport: 'stdio · ndjson JSON-RPC 2.0',
      },
      methods: [
        'initialize',
        'session/new',
        'session/load',
        'session/prompt',
        'session/cancel',
        'session/close',
        'session/set_config_option',
      ],
      notifications: ['session/update', 'session_title', 'tool_call', 'config_option_update'],
      connections: [...this.connections.values()].map((c) => c.describe()),
    }
  }

  /** retire connections whose SSE stream vanished (adapter crashed) */
  private ensureSweeper() {
    if (this.sweeper) return
    this.sweeper = setInterval(() => {
      const stale = 5 * 60_000
      const now = Date.now()
      for (const [id, conn] of this.connections) {
        if (now - conn.lastSeenAt > stale) this.close(id)
      }
      if (this.connections.size === 0 && this.sweeper) {
        clearInterval(this.sweeper)
        this.sweeper = null
      }
    }, 60_000)
    // never hold the process open on the sweeper
    if (typeof this.sweeper.unref === 'function') this.sweeper.unref()
  }
}

const g = globalThis as unknown as { __flintAcp?: AcpManager }
export const acp: AcpManager = g.__flintAcp ?? (g.__flintAcp = new AcpManager())

// ── turn cancellation (session/cancel → runTurn) ────────────
const gc = globalThis as unknown as { __flintTurnCancels?: Set<string> }
const turnCancels: Set<string> = (gc.__flintTurnCancels ??= new Set<string>())

export function requestTurnCancel(sessionId: string): boolean {
  turnCancels.add(sessionId)
  return true
}

export function isTurnCancelled(sessionId: string): boolean {
  return turnCancels.has(sessionId)
}

export function clearTurnCancel(sessionId: string): void {
  turnCancels.delete(sessionId)
}

// ── config-option surface (parity: pa-daemon config_options.rs)
export interface AcpConfigOption {
  id: string
  title: string
  description: string
  type: 'select' | 'string' | 'boolean'
  value: string
  options?: Array<{ name: string; value: string; description?: string }>
  default: string
}

export function configOptionsFor(rec: {
  model: string
  thinkingLevel: string
  models: Array<{ id: string; name: string; thinking: boolean }>
}): AcpConfigOption[] {
  return [
    {
      id: 'model',
      title: 'Model',
      description: 'The LLM the session routes to (per-session override).',
      type: 'select',
      value: rec.model,
      default: rec.model,
      options: rec.models.map((m) => ({ name: m.name, value: m.id })),
    },
    {
      id: 'thought_level',
      title: 'Thinking level',
      description: 'Reasoning effort handed to the model.',
      type: 'select',
      value: rec.thinkingLevel,
      default: 'off',
      options: [
        { name: 'off', value: 'off' },
        { name: 'low', value: 'low' },
        { name: 'medium', value: 'medium' },
        { name: 'high', value: 'high' },
      ],
    },
  ]
}

// ── prompt-block admission (parity: types.rs parse_prompt_blocks)
export interface AdmittedPrompt {
  text: string
  imageCount: number
}

export function admitPromptBlocks(prompt: unknown): { ok: true; prompt: AdmittedPrompt } | { ok: false; error: string } {
  if (!Array.isArray(prompt)) return { ok: false, error: 'prompt must be an array of content blocks' }
  const texts: string[] = []
  let imageCount = 0
  for (const block of prompt) {
    if (!block || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    const type = b.type
    if (type === 'text' && typeof b.text === 'string') {
      texts.push(b.text)
    } else if (type === 'image') {
      imageCount++
    } else if (type === 'resource') {
      const r = (b.resource ?? {}) as Record<string, unknown>
      const text = typeof r.text === 'string' ? r.text : ''
      const uri = typeof r.uri === 'string' ? r.uri + '\n' : ''
      if (text) texts.push(uri + text)
    } else if (type === 'resource_link') {
      if (typeof b.uri === 'string') texts.push(b.uri)
    }
  }
  const text = texts.join('\n').trim()
  if (!text && imageCount === 0) return { ok: false, error: 'prompt carries no admittable content' }
  return { ok: true, prompt: { text: text || '(image-only prompt — text required by this engine)', imageCount } }
}
