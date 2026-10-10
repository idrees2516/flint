#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// flint-acp — Flint's Agent Client Protocol adapter (stdio).
//
// Speaks ndjson JSON-RPC 2.0 on stdin/stdout to an ACP client
// (Zed, Neovim, …) and bridges to a running Flint server over
// HTTP + SSE. Parity with prime-agent's pa-daemon ACP surface:
//   initialize · session/new · session/load · session/prompt ·
//   session/cancel · session/close · session/set_config_option
//   → outgoing session/update notifications with a namespaced
//   _meta correlation envelope (ai.flint.agent).
//
// Usage:   FLINT_URL=http://127.0.0.1:3000 node scripts/flint-acp.mjs
// Zed:     {"flint": {"command": "node", "args": ["<repo>/scripts/flint-acp.mjs"]}}
// ─────────────────────────────────────────────────────────────

const FLINT_URL = (process.env.FLINT_URL || 'http://127.0.0.1:3000').replace(/\/$/, '')
const AGENT_NAME = 'flint'
const AGENT_TITLE = 'Flint'
const AGENT_VERSION = '1.0.0'
const META_NS = 'ai.flint.agent'
const PROTOCOL_VERSION = 1

// ── JSON-RPC framing (parity: pa-daemon jsonrpc.rs) ─────────
const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603

// serialize every stdout write — ACP requires one JSON object per line
const writeQueue = []
let writing = false
function writeLine(value) {
  writeQueue.push(JSON.stringify(value))
  if (!writing) flushWrites()
}
function flushWrites() {
  writing = true
  while (writeQueue.length > 0) {
    const line = writeQueue.shift()
    try {
      process.stdout.write(line + '\n')
    } catch {
      /* stdout gone — nothing to do */
    }
  }
  writing = false
}
const response = (id, result) => writeLine({ jsonrpc: '2.0', id, result })
const errorResponse = (id, code, message, data) =>
  writeLine({ jsonrpc: '2.0', id, error: data ? { code, message, data } : { code, message } })
const notification = (method, params) => writeLine({ jsonrpc: '2.0', method, params })

function parseLine(line) {
  const badRequest = () => ({ err: { id: null, code: INVALID_REQUEST, message: 'Invalid Request' } })
  let value
  try {
    value = JSON.parse(line.trim())
  } catch {
    return { err: { id: null, code: PARSE_ERROR, message: 'Parse error' } }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return badRequest()
  if (value.jsonrpc !== '2.0') return badRequest()
  if (typeof value.method !== 'string') return badRequest()
  const params = value.params ?? {}
  if (value.id === undefined || value.id === null) return { notification: { method: value.method, params } }
  return { request: { id: value.id, method: value.method, params } }
}

// ── connection state ─────────────────────────────────────────
let connectionId = null
let sseAbort = null
let eventSequence = 0
let serverUp = false

/** sessions tracked by this adapter: sessionId → record */
const sessions = new Map()

function sessionRec(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      sessionId,
      title: '',
      ready: false, // session/new|load response not yet written
      held: [], // updates published before the response frame
      promptTurnId: 0,
      turnDoneSeen: false,
      agentChunkEmitted: false,
      lastToolCallId: null,
    })
  }
  return sessions.get(sessionId)
}

/** emit one ACP session/update notification (respecting hold-back) */
function update(sessionId, updateObj, phase = 'event') {
  const rec = sessionRec(sessionId)
  const seq = ++eventSequence
  const frame = () =>
    notification('session/update', {
      sessionId,
      update: updateObj,
      _meta: {
        [META_NS]: {
          promptTurnId: rec.promptTurnId || undefined,
          eventSequence: seq,
          phase,
        },
      },
    })
  if (!rec.ready) rec.held.push(frame)
  else frame()
}

function flushHeld(sessionId) {
  const rec = sessionRec(sessionId)
  rec.ready = true
  for (const frame of rec.held.splice(0)) frame()
}

// ── HTTP client ──────────────────────────────────────────────
async function api(path, init = {}) {
  const res = await fetch(FLINT_URL + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
    signal: init.signal ?? AbortSignal.timeout(init.timeoutMs ?? 60_000),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const detail = typeof body.error === 'string' ? body.error : JSON.stringify(body).slice(0, 300)
    throw Object.assign(new Error(detail), { status: res.status, body })
  }
  return body
}

async function ensureConnection() {
  if (connectionId) return connectionId
  const { connectionId: id } = await api('/api/flint/acp/connect', {
    method: 'POST',
    body: JSON.stringify({ clientInfo: { name: 'flint-acp', version: AGENT_VERSION } }),
  })
  connectionId = id
  startSse(id)
  return id
}

// ── SSE ingestion → update translation ───────────────────────
function startSse(id) {
  if (sseAbort) sseAbort.abort()
  const controller = new AbortController()
  sseAbort = controller
  ;(async () => {
    try {
      const res = await fetch(`${FLINT_URL}/api/flint/acp/connect?id=${encodeURIComponent(id)}`, {
        signal: controller.signal,
        headers: { accept: 'text/event-stream' },
      })
      if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`)
      serverUp = true
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '')
          buf = buf.slice(nl + 1)
          if (line.startsWith('data: ')) {
            try {
              onServerFrame(JSON.parse(line.slice(6)))
            } catch {
              /* ignore malformed frames */
            }
          }
        }
      }
    } catch {
      // server dropped or unreachable — the next ensureConnection retries
      serverUp = false
    }
  })()
}

function onServerFrame(frame) {
  // shape: { type: 'acp:hello' } | { event, sessionId, seq }
  if (!frame || frame.type === 'acp:hello') return
  const { event, sessionId } = frame
  if (!event || !sessionId || !sessions.has(sessionId)) return
  const rec = sessionRec(sessionId)
  const data = event.data || {}

  switch (event.type) {
    case 'session:code': {
      const toolCallId = `tc_${sessionId.slice(0, 8)}_${++eventSequence}`
      rec.lastToolCallId = toolCallId
      update(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId,
        title: 'python · kernel eval',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { language: 'python', code: data.code ?? '' },
      })
      break
    }
    case 'session:stdout': {
      if (!rec.lastToolCallId) break
      const text = String(data.observation ?? event.message ?? '')
      update(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: rec.lastToolCallId,
        status: data.ok === false ? 'failed' : 'completed',
        content: [{ type: 'content', content: { type: 'text', text } }],
        _meta: { [META_NS]: { durationMs: data.durationMs } },
      })
      break
    }
    case 'session:turn-done': {
      rec.turnDoneSeen = true
      // emit the agent's final answer ahead of the prompt response
      if (!rec.agentChunkEmitted && typeof data.final === 'string' && data.final) {
        rec.agentChunkEmitted = true
        update(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          messageId: `msg_${sessionId.slice(0, 8)}_${rec.promptTurnId}`,
          content: { type: 'text', text: data.final },
        })
      }
      update(
        sessionId,
        {
          sessionUpdate: 'session_info_update',
          _meta: {
            [META_NS]: {
              outcome: data.cancelled ? 'cancelled' : 'result',
              iterations: data.iterations,
              budgetReached: data.budgetReached,
            },
          },
        },
        'responseBoundary'
      )
      break
    }
    case 'session:error':
      update(sessionId, {
        sessionUpdate: 'session_info_update',
        _meta: { [META_NS]: { error: event.message } },
      })
      break
    case 'session:compacted':
      update(sessionId, {
        sessionUpdate: 'session_info_update',
        _meta: { [META_NS]: { compaction: { status: 'done' } } },
      })
      break
    case 'session:created':
      if (data.role === 'subagent') {
        update(sessionId, {
          sessionUpdate: 'session_info_update',
          _meta: { [META_NS]: { subagents: [{ sessionId: data.sessionId, depth: data.depth, model: data.model }] } },
        })
      }
      break
    case 'a2a:sent':
      update(sessionId, {
        sessionUpdate: 'session_info_update',
        _meta: { [META_NS]: { agentMessage: data } },
      })
      break
    case 'kernel:restarted':
    case 'kernel:evicted':
      update(sessionId, {
        sessionUpdate: 'session_info_update',
        _meta: { [META_NS]: { kernel: { event: event.type } } },
      })
      break
    default:
      break // untracked event types are dropped, not invented
  }
}

// ── prompt-block admission (client-side mirror of the server) ─
function promptText(prompt) {
  if (!Array.isArray(prompt)) return { error: 'prompt must be an array of content blocks' }
  const texts = []
  let images = 0
  for (const block of prompt) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    else if (block.type === 'image') images++
    else if (block.type === 'resource' && block.resource && typeof block.resource.text === 'string') {
      texts.push((block.resource.uri ? block.resource.uri + '\n' : '') + block.resource.text)
    } else if (block.type === 'resource_link' && typeof block.uri === 'string') texts.push(block.uri)
  }
  const text = texts.join('\n').trim()
  if (images > 0) return { error: 'image blocks are not supported (promptCapabilities.image = false)' }
  if (!text) return { error: 'prompt carries no admittable content' }
  return { text }
}

/** let in-flight SSE frames land before a prompt response is written */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── method handlers ──────────────────────────────────────────
const handlers = {
  async initialize({ params }) {
    try {
      await ensureConnection()
      serverUp = true
    } catch (e) {
      return { __error: { code: INTERNAL_ERROR, message: `cannot reach Flint server at ${FLINT_URL}: ${e.message}` } }
    }
    const requested = typeof params.protocolVersion === 'number' ? params.protocolVersion : PROTOCOL_VERSION
    return {
      protocolVersion: Math.min(requested, PROTOCOL_VERSION),
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, embeddedContext: true },
        mcpCapabilities: { http: true },
        sessionCapabilities: { close: {} },
      },
      agentInfo: { name: AGENT_NAME, title: AGENT_TITLE, version: AGENT_VERSION },
      _meta: {
        [META_NS]: {
          server: FLINT_URL,
          runtime: 'flint-rlm',
          features: ['kernel', 'subagents', 'a2a', 'goals', 'heartbeats', 'factory', 'mcp', 'compaction'],
        },
      },
    }
  },

  async 'session/new'({ params }) {
    await ensureConnection()
    const created = await api('/api/flint/acp/sessions', {
      method: 'POST',
      body: JSON.stringify({
        connectionId,
        cwd: params.cwd,
        mcpServers: params.mcpServers,
      }),
    })
    const rec = sessionRec(created.sessionId)
    rec.title = created.title || created.sessionId
    rec.ready = false
    // held until the response frame is queued — then the title flushes
    update(created.sessionId, {
      sessionUpdate: 'session_title',
      title: rec.title,
      _meta: { [META_NS]: { cwd: { requested: created.cwd?.requested ?? null, actual: created.cwd?.actual ?? null } } },
    })
    return {
      __holdSession: created.sessionId,
      sessionId: created.sessionId,
      ...(created.mcpRegistered?.length ? { _meta: { [META_NS]: { mcpRegistered: created.mcpRegistered } } } : {}),
    }
  },

  async 'session/load'({ params }) {
    if (!params.sessionId) return { __error: { code: INVALID_PARAMS, message: 'sessionId required' } }
    await ensureConnection()
    const loaded = await api('/api/flint/acp/sessions', {
      method: 'POST',
      body: JSON.stringify({ connectionId, sessionId: params.sessionId, cwd: params.cwd, mcpServers: params.mcpServers }),
    })
    const rec = sessionRec(params.sessionId)
    rec.title = loaded.title || params.sessionId
    rec.ready = false
    update(params.sessionId, { sessionUpdate: 'session_title', title: rec.title })
    return { __holdSession: loaded.sessionId, sessionId: loaded.sessionId }
  },

  async 'session/prompt'({ params }) {
    const sessionId = params.sessionId
    if (!sessionId || !sessions.has(sessionId)) {
      return { __error: { code: INVALID_PARAMS, message: 'unknown sessionId — session/new first' } }
    }
    const admitted = promptText(params.prompt)
    if (admitted.error) return { __error: { code: INVALID_PARAMS, message: admitted.error } }

    const rec = sessionRec(sessionId)
    rec.promptTurnId = (rec.promptTurnId || 0) + 1
    rec.turnDoneSeen = false
    rec.agentChunkEmitted = false

    // echo the user's prompt (ACP user_message_chunk)
    update(sessionId, {
      sessionUpdate: 'user_message_chunk',
      messageId: `user_${sessionId.slice(0, 8)}_${rec.promptTurnId}`,
      content: { type: 'text', text: admitted.text },
    })

    let result
    try {
      result = await api(`/api/flint/acp/sessions/${encodeURIComponent(sessionId)}/prompt`, {
        method: 'POST',
        body: JSON.stringify({ prompt: params.prompt }),
        timeoutMs: 300_000,
      })
    } catch (e) {
      if (e.status === 409) {
        return { stopReason: 'cancelled' }
      }
      // emit whatever partial state arrived, then surface the error
      update(sessionId, {
        sessionUpdate: 'session_info_update',
        _meta: { [META_NS]: { error: e.message } },
      })
      throw e
    }

    // let SSE stragglers land (they may carry the agent_message_chunk)
    await sleep(150)
    if (!rec.agentChunkEmitted && result.final) {
      rec.agentChunkEmitted = true
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        messageId: `msg_${sessionId.slice(0, 8)}_${rec.promptTurnId}`,
        content: { type: 'text', text: result.final },
      })
      await sleep(20)
    }
    return { stopReason: result.stopReason || 'end_turn' }
  },

  async 'session/cancel'({ params }) {
    if (!params.sessionId) return { __error: { code: INVALID_PARAMS, message: 'sessionId required' } }
    await api(`/api/flint/acp/sessions/${encodeURIComponent(params.sessionId)}/cancel`, {
      method: 'POST',
      body: '{}',
    }).catch(() => null)
    return {} // notification — no response is written, this is defensive
  },

  async 'session/close'({ params }) {
    if (!params.sessionId) return { __error: { code: INVALID_PARAMS, message: 'sessionId required' } }
    const out = await api(`/api/flint/acp/sessions/${encodeURIComponent(params.sessionId)}/close`, {
      method: 'POST',
      body: '{}',
    })
    sessions.delete(params.sessionId)
    return out
  },

  async 'session/set_config_option'({ params }) {
    const sessionId = params.sessionId
    if (!sessionId) return { __error: { code: INVALID_PARAMS, message: 'sessionId required' } }
    const out = await api(`/api/flint/acp/sessions/${encodeURIComponent(sessionId)}/config`, {
      method: 'POST',
      body: JSON.stringify({ id: params.id, value: params.value }),
    })
    // config_option_update carries the full set with current values
    update(sessionId, { sessionUpdate: 'config_option_update', configOptions: out.configOptions })
    return { configOptions: out.configOptions }
  },
}

// ── dispatch ─────────────────────────────────────────────────
async function dispatch(msg) {
  const { request, notification: notif } = msg
  if (request) {
    const { id, method, params } = request
    const handler = handlers[method]
    if (!handler) {
      errorResponse(id, METHOD_NOT_FOUND, `method not found: ${method}`)
      return
    }
    try {
      const result = await handler({ id, method, params })
      if (result && result.__error) {
        errorResponse(id, result.__error.code, result.__error.message)
      } else if (result && result.__holdSession) {
        // session/new | session/load — flush held updates after the frame
        const { __holdSession, ...rest } = result
        response(id, rest)
        flushHeld(__holdSession)
      } else {
        response(id, result)
      }
    } catch (e) {
      errorResponse(id, INTERNAL_ERROR, String(e.message || e).slice(0, 400))
    }
    return
  }
  if (notif) {
    const handler = handlers[notif.method]
    if (handler) {
      try {
        await handler({ id: null, method: notif.method, params: notif.params })
      } catch (e) {
        console.error(`[flint-acp] ${notif.method}:`, e.message || e)
      }
    }
    // notifications never get a response
  }
}

// ── stdio loop ───────────────────────────────────────────────
import { createInterface } from 'node:readline'
const rl = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity })
rl.on('line', (line) => {
  if (!line.trim()) return
  const msg = parseLine(line)
  if (msg.err) {
    errorResponse(msg.err.id, msg.err.code, msg.err.message)
    return
  }
  void dispatch(msg)
})

async function teardown(code) {
  try {
    if (sseAbort) sseAbort.abort()
    if (connectionId) {
      await fetch(`${FLINT_URL}/api/flint/acp/connect?id=${encodeURIComponent(connectionId)}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(1500),
      }).catch(() => null)
    }
  } catch {
    /* best effort */
  }
  process.exit(code)
}
rl.on('close', () => void teardown(0))
process.on('SIGTERM', () => void teardown(0))
process.on('SIGINT', () => void teardown(0))
process.on('uncaughtException', (e) => {
  console.error('[flint-acp] uncaught:', e)
  void teardown(1)
})
