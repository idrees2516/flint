// Flint · Durable Restart Test — proves state, snapshots, spaces and
// alarms survive a FULL server restart (the DO durability contract).
//   node scripts/test-durable-restart.mjs pre   (before restart)
//   node scripts/test-durable-restart.mjs post  (after restart)
import fs from 'fs'

const BASE = process.argv[3] || 'http://localhost:3000'
const MODE = process.argv[2] ?? 'pre'
const MARK = '/tmp/flint-restart-mark.json'

let passed = 0, failed = 0
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`) }
  else { failed++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}
const api = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, data: await res.json().catch(() => ({})) }
}

async function main() {
  await api('GET', '/api/flint/bootstrap')

  if (MODE === 'pre') {
    console.log('── RESTART TEST · PRE (setup state + 12s durable alarm) ──')
    const { data: session } = await api('POST', '/api/flint/sessions', { name: 'restart-survivor' })
    const sid = session.session?.id ?? session.id
    const actor = `agent:${sid}`

    await api('POST', `/api/flint/durable/${actor}/rpc`, { method: 'syncSession', args: [] })
    await api('PATCH', `/api/flint/durable/${actor}/state`, { patch: { canary: 'alive-before-restart', deep: { thought: 'state must survive' } } })
    await api('POST', `/api/flint/durable/${actor}/events`, { topic: 'restart-log', payload: { mark: 'before' } })
    const ck = await api('POST', `/api/flint/durable/${actor}/rpc`, { method: 'takeCheckpoint', args: ['pre-restart'] })

    await api('POST', '/api/flint/spaces/e2e-space/kv', { key: 'restart/canary', value: 'spaces-survive' })
    await api('POST', '/api/flint/spaces/e2e-space/publish', { topic: 'restart', payload: { phase: 'pre' } })

    const run1 = await api('POST', '/api/flint/mesh/exec', {
      command: 'echo "persisted by mesh" > proof.txt',
      makeSnapshotOut: true, captureGlobs: ['*.txt'], timeoutMs: 30_000,
    })

    // durable alarm: 12s out — the server will be DOWN and RESTARTED
    // before it fires; it must still fire after the restart
    const alarm = await api('POST', `/api/flint/durable/${actor}/alarms`, {
      delayMs: 12_000, prompt: 'restart-survivor alarm: I survived the restart', mode: 'note',
    })

    fs.writeFileSync(MARK, JSON.stringify({ sid, ckRef: ck.data.result?.ref, snap: run1.data.task?.snapshotOut, at: Date.now() }))
    console.log(`  state set, checkpoint ${ck.data.result?.ref?.slice(0, 14)}…, alarm at +12s (fires AFTER restart)`)
    console.log('  → now: kill the server, restart it, run "post"')
    ok('pre-flight complete', !!sid && !!run1.data.task?.snapshotOut && alarm.data.ok)
    console.log(`══ PRE: ${passed} passed · ${failed} failed ══`)
    return
  }

  // ── POST ─────────────────────────────────────────────────────
  console.log('── RESTART TEST · POST (verify everything survived) ──')
  const mark = JSON.parse(fs.readFileSync(MARK, 'utf8'))
  const actor = `agent:${mark.sid}`

  const st = await api('GET', `/api/flint/durable/${actor}/state`)
  ok('actor state survived restart', st.data.state?.canary === 'alive-before-restart' && st.data.state?.deep?.thought === 'state must survive', `canary=${st.data.state?.canary}`)

  const evs = await api('GET', `/api/flint/durable/${actor}/events?topic=restart-log&limit=5`)
  ok('event log survived restart', (evs.data.events ?? []).some((e) => e.payload?.mark === 'before'))

  const kv = await api('GET', '/api/flint/spaces/e2e-space/kv?key=restart/canary')
  ok('shared space KV survived restart', kv.data.entry?.value === 'spaces-survive')

  const ckList = await api('GET', `/api/flint/durable/${actor}/snapshots?kind=state`)
  ok('snapshot registry survived restart', (ckList.data.snapshots ?? []).length >= 1, `${ckList.data.snapshots?.length} snapshots`)

  const restore = await api('POST', `/api/flint/durable/${actor}/snapshots`, { op: 'restore', ref: mark.ckRef })
  ok('checkpoint restorable after restart', restore.data.ok === true && restore.data.restore?.restored === true)

  const load = await api('POST', '/api/flint/mesh/exec', {
    command: 'cat proof.txt', snapshotIn: mark.snap, timeoutMs: 30_000,
  })
  ok('mesh snapshot restorable after restart (proof.txt)', load.data.ok === true && (load.data.task?.stdout ?? '').includes('persisted by mesh'))

  // the alarm scheduled BEFORE the restart must fire AFTER it
  let alarmFired = false
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    const s = await api('GET', `/api/flint/durable/${actor}/state`)
    if (s.data.state?.wakeNote?.includes('survived the restart')) { alarmFired = true; break }
  }
  ok('durable alarm fired AFTER restart (scheduled before it)', alarmFired)

  console.log(`══ POST: ${passed} passed · ${failed} failed ══`)
  if (failed) process.exit(1)
}

main().catch((e) => { console.error('restart test crashed:', e); process.exit(1) })
