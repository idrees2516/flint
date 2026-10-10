#!/usr/bin/env node
// E2E test: drives scripts/flint-acp.mjs like an ACP editor (Zed).
// Verifies: initialize → session/new → session/prompt (streamed updates
// + stopReason) → set_config_option → session/close → clean teardown.
import { spawn } from 'node:child_process'

const FLINT_URL = process.env.FLINT_URL || 'http://127.0.0.1:3000'
const child = spawn('node', ['scripts/flint-acp.mjs'], {
  cwd: process.cwd(),
  env: { ...process.env, FLINT_URL },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let buf = ''
const pending = new Map() // id → {resolve, reject, tag}
const updates = [] // session/update notifications
let nextId = 1

function send(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
}

const timers = []
child.stdout.on('data', (chunk) => {
  buf += chunk.toString()
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.method === 'session/update') {
      updates.push(msg.params)
      console.log(`  [update] ${msg.params.sessionId.slice(0, 8)} · ${msg.params.update.sessionUpdate}`)
    } else if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result)
    }
  }
})
child.stderr.on('data', (d) => console.error('  [adapter-stderr]', d.toString().trim()))
child.on('exit', (code) => console.log(`  [adapter exited ${code}]`))

const assert = (cond, label) => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${label}`)
  if (!cond) process.exitCode = 1
}
const wait = (ms) => new Promise((r) => timers.push(setTimeout(r, ms)))

try {
  // 1. initialize
  console.log('1. initialize')
  const init = await send('initialize', { protocolVersion: 1, clientInfo: { name: 'flint-e2e', version: '0' } })
  assert(init.protocolVersion === 1, `protocolVersion=1 (got ${init.protocolVersion})`)
  assert(init.agentCapabilities.loadSession === true, 'loadSession=true')
  assert(init.agentCapabilities.sessionCapabilities.close !== undefined, 'session/close served')
  assert(init.agentCapabilities.promptCapabilities.image === false, 'image=false (text-first engine)')
  assert(init.agentInfo.name === 'flint', 'agentInfo.name=flint')

  // 2. session/new
  console.log('2. session/new')
  const created = await send('session/new', { cwd: '/tmp/flint-acp-e2e', mcpServers: [] })
  const sid = created.sessionId
  assert(!!sid, `sessionId assigned (${sid?.slice(0, 12)}…)`)
  await wait(150)
  assert(updates.some((u) => u.update.sessionUpdate === 'session_title'), 'session_title update flushed after response')

  // 3. session/prompt — a deterministic kernel-math task
  console.log('3. session/prompt (kernel math)')
  const promptPromise = send('session/prompt', {
    sessionId: sid,
    prompt: [
      { type: 'text', text: 'Compute 6*7 in your Python kernel and reply with just the number and how you got it.' },
    ],
  })
  const result = await promptPromise
  console.log(`  stopReason=${result.stopReason} iterations=${result.iterations}`)
  assert(result.stopReason === 'end_turn', `stopReason=end_turn (got ${result.stopReason})`)
  assert(updates.some((u) => u.update.sessionUpdate === 'user_message_chunk'), 'user_message_chunk echoed')
  assert(updates.some((u) => u.update.sessionUpdate === 'tool_call' && u.update.kind === 'execute'), 'tool_call (execute) streamed')
  assert(updates.some((u) => u.update.sessionUpdate === 'tool_call_update' && u.update.status === 'completed'), 'tool_call_update completed')
  assert(updates.some((u) => u.update.sessionUpdate === 'agent_message_chunk'), 'agent_message_chunk streamed')
  assert(updates.some((u) => u.update.sessionUpdate === 'session_info_update'), 'session_info_update (responseBoundary meta)')

  // 4. set_config_option — model switch mid-conversation
  console.log('4. session/set_config_option')
  const cfg = await send('session/set_config_option', { sessionId: sid, id: 'model', value: 'glm-4.7-flash' })
  assert(Array.isArray(cfg.configOptions) && cfg.configOptions.length >= 2, `configOptions returned (${cfg.configOptions?.length})`)
  assert(cfg.configOptions.find((o) => o.id === 'model')?.value === 'glm-4.7-flash', 'model switched to glm-4.7-flash')
  assert(cfg.configOptions.find((o) => o.id === 'thought_level'), 'thought_level option present')
  await wait(120)
  assert(updates.some((u) => u.update.sessionUpdate === 'config_option_update'), 'config_option_update notification')

  // 5. second prompt on switched model — cheap sanity
  console.log('5. session/prompt (post-switch)')
  const r2 = await send('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'What is 2+3? Just the number.' }] })
  assert(r2.stopReason === 'end_turn', `second turn end_turn (got ${r2.stopReason})`)

  // 6. session/load — adopt the same session on a fresh record
  console.log('6. session/load')
  const loaded = await send('session/load', { sessionId: sid })
  assert(loaded.sessionId === sid, 'session/load adopts existing session')

  // 7. session/close
  console.log('7. session/close')
  const closed = await send('session/close', { sessionId: sid })
  assert(closed.ok === true, 'session closed')

  // 8. malformed input resilience (parse error answered, adapter alive)
  console.log('8. malformed frame')
  child.stdin.write('this is not json\n')
  await wait(150)
  const alive = await send('initialize', { protocolVersion: 1 })
  assert(alive.agentInfo.name === 'flint', 'adapter still alive after parse error')

  console.log(process.exitCode ? '\nE2E: FAILURES ↑' : '\nE2E: ALL PASS')
} catch (e) {
  console.error('E2E error:', e.message)
  process.exitCode = 1
} finally {
  child.stdin.end()
  await wait(400)
  for (const t of timers) clearTimeout(t)
  child.kill('SIGTERM')
}
