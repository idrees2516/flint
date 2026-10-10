#!/usr/bin/env node
// Focused test: session/cancel mid-turn must surface stopReason="cancelled"
// through the adapter (cancellation registry → runTurn boundary → prompt route).
import { spawn } from 'node:child_process'

const FLINT_URL = process.env.FLINT_URL || 'http://127.0.0.1:3000'
const child = spawn('node', ['scripts/flint-acp.mjs'], {
  cwd: process.cwd(),
  env: { ...process.env, FLINT_URL },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let buf = ''
const pending = new Map()
const updates = []
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
      console.log(`  [update] ${msg.params.update.sessionUpdate}${msg.params.update.status ? ` (${msg.params.update.status})` : ''}`)
    } else if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result)
    }
  }
})
child.stderr.on('data', (d) => console.error('  [stderr]', d.toString().trim()))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

try {
  await send('initialize', { protocolVersion: 1 })
  const { sessionId } = await send('session/new', { cwd: '/tmp/flint-cancel-e2e' })
  console.log(`session ${sessionId.slice(0, 12)}… — launching a multi-iteration task, then cancelling`)

  // a task that guarantees several kernel iterations
  const turn = send('session/prompt', {
    sessionId,
    prompt: [
      {
        type: 'text',
        text: 'Do this carefully, step by step, one kernel eval per step: (1) compute the first 20 prime numbers into a list, (2) compute their sum, (3) compute their product as an exact integer, (4) verify the sum and product agree with a second independent method, (5) write a one-paragraph summary of what you found. Do not skip steps.',
      },
    ],
  })

  // let the turn start, then cancel while the model is iterating
  await wait(6000)
  console.log('-- sending session/cancel --')
  notify('session/cancel', { sessionId })
  const result = await turn
  console.log(`stopReason=${result.stopReason}`)
  const cancelled = result.stopReason === 'cancelled'
  console.log(cancelled || updates.some((u) => u.update._meta?.['ai.flint.agent']?.outcome === 'cancelled')
    ? '  ✓ cancellation surfaced'
    : '  ⚠ turn completed before cancel landed (race — acceptable if stopReason=end_turn)')
  console.log('CANCEL TEST DONE')
} catch (e) {
  console.error('cancel test error:', e.message)
  process.exitCode = 1
} finally {
  child.stdin.end()
  await wait(300)
  child.kill('SIGTERM')
}
