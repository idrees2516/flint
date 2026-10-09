// ─────────────────────────────────────────────────────────────
// Flint · Realtime Gateway (mini-service)
//   :3003 — socket.io (path '/'), live terminal + event fan-out
//   :3004 — localhost-only internal HTTP (event publishing,
//           health) — separate port because socket.io with
//           path '/' captures every request on its server.
// ─────────────────────────────────────────────────────────────
import { createServer } from 'http'
import { Server } from 'socket.io'
import { exec as cpExec, spawn } from 'child_process'

const PORT = 3003
const INTERNAL_PORT = 3004
const NEXT_API = 'http://127.0.0.1:3000'

let io: Server

// ── socket.io gateway (3003) ─────────────────────────────────
const httpServer = createServer()
io = new Server(httpServer, {
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 2e6,
})

// ── sandbox info cache (avoid hammering Next API) ────────────
const sbxCache = new Map<string, { at: number; data: SandboxInfo | null }>()
const SBX_TTL = 5000

interface SandboxInfo {
  sandbox: { id: string; name: string; status: string; driver: string; workspacePath?: string | null }
  metrics?: Record<string, unknown> | null
}

async function getSandbox(id: string): Promise<SandboxInfo | null> {
  const hit = sbxCache.get(id)
  if (hit && Date.now() - hit.at < SBX_TTL) return hit.data
  const data = await fetch(`${NEXT_API}/api/flint/sandboxes/${id}`)
    .then((r) => (r.ok ? (r.json() as Promise<SandboxInfo>) : null))
    .catch(() => null)
  sbxCache.set(id, { at: Date.now(), data })
  return data
}

async function ensureRunning(id: string): Promise<void> {
  const info = await getSandbox(id)
  if (info && info.sandbox.status !== 'running') {
    await fetch(`${NEXT_API}/api/flint/sandboxes/${id}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'start' }),
    }).catch(() => {})
  }
}

const BLOCKED = /\b(rm\s+-rf\s+\/|mkfs|dd\s+if=\/dev\/[a-z]+d|shutdown|reboot)\b/

io.on('connection', (socket) => {
  socket.emit('flint:event', { type: 'fleet:metric', message: 'realtime gateway connected', ts: Date.now() })

  socket.on('subscribe', (refId: string) => {
    if (typeof refId === 'string' && refId.length < 64) socket.join(refId)
  })
  socket.on('unsubscribe', (refId: string) => {
    if (typeof refId === 'string') socket.leave(refId)
  })

  // ── live terminal: real process execution in workspace ────
  socket.on('terminal:exec', async (msg: { sandboxId: string; cmd: string; seq: number }) => {
    const { sandboxId, cmd, seq } = msg ?? ({} as typeof msg)
    if (!sandboxId || typeof cmd !== 'string') return
    const started = Date.now()
    try {
      const info = await getSandbox(sandboxId)
      if (!info) {
        socket.emit('terminal:out', { seq, stderr: 'sandbox not found\n', exitCode: 1, done: true, durationMs: Date.now() - started })
        return
      }
      await ensureRunning(sandboxId)

      if (BLOCKED.test(cmd)) {
        socket.emit('terminal:out', { seq, stderr: 'flint: command blocked by sandbox policy\n', exitCode: 126, done: true, durationMs: 2 })
        return
      }

      // simulated cloud-vm session
      if (info.sandbox.driver === 'cloud-vm' || info.sandbox.workspacePath?.startsWith('vm://')) {
        await new Promise((r) => setTimeout(r, 60 + Math.random() * 220))
        socket.emit('terminal:out', {
          seq,
          stdout: `flint-vm [${info.sandbox.id.slice(-8)}] $ ${cmd}\n(booted from snapshot · simulated VM session)\n`,
          exitCode: 0,
          done: true,
          durationMs: Date.now() - started,
        })
        return
      }

      // real execution in the sandbox workspace
      const cwd = info.sandbox.workspacePath ?? process.cwd()
      const child = spawn('/bin/bash', ['-c', cmd], {
        cwd,
        env: { ...process.env, FLINT_SANDBOX: sandboxId, TERM: 'xterm-256color' },
      })
      const timeout = setTimeout(() => child.kill('SIGKILL'), 15000)
      child.stdout.on('data', (d: Buffer) => socket.emit('terminal:out', { seq, stdout: d.toString() }))
      child.stderr.on('data', (d: Buffer) => socket.emit('terminal:out', { seq, stderr: d.toString() }))
      child.on('close', (code) => {
        clearTimeout(timeout)
        socket.emit('terminal:out', { seq, exitCode: code ?? 0, done: true, durationMs: Date.now() - started })
      })
    } catch (e) {
      socket.emit('terminal:out', { seq, stderr: String(e) + '\n', exitCode: 1, done: true, durationMs: Date.now() - started })
    }
  })

  // ── file browser listing ──────────────────────────────────
  socket.on('files:list', async (msg: { sandboxId: string }) => {
    const { sandboxId } = msg ?? {}
    if (!sandboxId) return
    const info = await getSandbox(sandboxId).catch(() => null)
    if (!info || !info.sandbox.workspacePath || info.sandbox.workspacePath?.startsWith('vm://')) {
      socket.emit('files:list', { sandboxId, files: [] })
      return
    }
    cpExec(
      `find ${JSON.stringify(info.sandbox.workspacePath)} -maxdepth 2 -not -path '*/.*' -not -path '*/node_modules*' | head -80`,
      { shell: '/bin/bash' },
      (err, stdout) => {
        socket.emit('files:list', { sandboxId, files: (stdout ?? '').split('\n').filter(Boolean) })
      }
    )
  })
})

httpServer.listen(PORT, () => {
  console.log(`[flint-realtime] socket.io gateway on :${PORT}`)
})

// ── internal HTTP (3004, localhost only) ─────────────────────
const internal = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname === '/internal/publish' && req.method === 'POST') {
    let body = ''
    for await (const chunk of req) body += chunk
    try {
      const event = JSON.parse(body)
      io.emit('flint:event', event)
      if (event.refId) io.to(event.refId).emit('flint:event', event)
      res.writeHead(202)
      res.end()
    } catch {
      res.writeHead(400)
      res.end()
    }
    return
  }
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, svc: 'flint-realtime', clients: io.engine?.clientsCount ?? 0 }))
    return
  }
  res.writeHead(404)
  res.end()
})

internal.listen(INTERNAL_PORT, '127.0.0.1', () => {
  console.log(`[flint-realtime] internal publish on :${INTERNAL_PORT}`)
})
