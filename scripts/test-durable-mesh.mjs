// Flint · Durable Mesh E2E — verifies the 2026 scale layer:
//   1. Durable runtime (actor RPC, state, events, snapshots, alarms)
//   2. Shared spaces (KV, pub/sub, handoff)
//   3. Stateless sandbox mesh (exec, files, snapshot-in/out continuity)
//   4. Durability across a full server restart (phase 2 separate)
// Usage: node scripts/test-durable-mesh.mjs [BASE_URL]
const BASE = process.argv[2] || 'http://localhost:3000'

let passed = 0
let failed = 0
const failures = []

function ok(name, cond, extra = '') {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`)
  } else {
    failed++
    failures.push(name + (extra ? ` (${extra})` : ''))
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`)
  }
}

const j = (r) => r.json()
async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, data: await res.json().catch(() => ({})) }
}

async function main() {
  console.log('── Flint Durable Mesh E2E ──')
  await api('GET', '/api/flint/bootstrap')

  // ── 1. durable runtime ──────────────────────────────────────
  console.log('\n[1] Durable runtime — actors, RPC, state, events, snapshots, alarms')

  // create a throwaway session to attach an AgentActor
  const { data: session } = await api('POST', '/api/flint/sessions', { name: 'durable-e2e' })
  const sid = session.session?.id ?? session.id
  ok('session created', !!sid)
  const actor = `agent:${sid}`

  const rpc1 = await api('POST', `/api/flint/durable/${actor}/rpc`, { method: 'syncSession', args: [] })
  ok('RPC syncSession', rpc1.data.ok === true && rpc1.data.result?.sessionId === sid)

  const st1 = await api('GET', `/api/flint/durable/${actor}/state`)
  ok('state read', st1.status === 200 && st1.data.state?.name === 'durable-e2e', `status=${st1.data.state?.status}`)

  const patch1 = await api('PATCH', `/api/flint/durable/${actor}/state`, { patch: { mood: 'focused', task: 'research' } })
  ok('state PATCH → versioned', patch1.data.ok === true && typeof patch1.data.version === 'number', `v${patch1.data.version}`)
  const v1 = patch1.data.version

  const patch2 = await api('PATCH', `/api/flint/durable/${actor}/state`, { patch: { mood: 'reflective' } })
  ok('state version increments (output gate)', patch2.data.version === v1 + 1, `v${v1} → v${patch2.data.version}`)

  const st2 = await api('GET', `/api/flint/durable/${actor}/state`)
  ok('state persisted + merged', st2.data.state?.mood === 'reflective' && st2.data.state?.task === 'research')

  const ev1 = await api('POST', `/api/flint/durable/${actor}/events`, { topic: 'milestones', payload: { note: 'phase-1 done' } })
  ok('event appended', ev1.data.ok === true && ev1.data.event?.seq >= 1, `seq=${ev1.data.event?.seq}`)
  const ev2 = await api('POST', `/api/flint/durable/${actor}/events`, { topic: 'milestones', payload: { note: 'phase-2 done' } })
  const evList = await api('GET', `/api/flint/durable/${actor}/events?topic=milestones&limit=10`)
  ok('event log topic-filtered replay', Array.isArray(evList.data.events) && evList.data.events.length >= 2, `${evList.data.events?.length} events`)

  // single-writer serialization: 20 concurrent patches must yield +20 versions
  const concurrent = await Promise.all(
    Array.from({ length: 20 }, (_, i) => api('PATCH', `/api/flint/durable/${actor}/state`, { patch: { [`field${i}`]: i } }))
  )
  const versions = concurrent.map((r) => r.data.version).filter((v) => typeof v === 'number')
  ok('single-writer serialization (20 concurrent patches, no lost updates)', new Set(versions).size === 20, `unique versions: ${new Set(versions).size}/20`)

  // snapshots
  const snap = await api('POST', `/api/flint/durable/${actor}/snapshots`, { op: 'save', kind: 'state', blob: '{}', manifest: { label: 'e2e' } })
  // take a real actor checkpoint via RPC (AgentActor method)
  const ck = await api('POST', `/api/flint/durable/${actor}/rpc`, { method: 'takeCheckpoint', args: ['e2e-checkpoint'] })
  ok('durable checkpoint saved', ck.data.ok === true && !!ck.data.result?.ref, ck.data.result?.ref?.slice(0, 18) + '…')
  const ckRef = ck.data.result?.ref

  const snapList = await api('GET', `/api/flint/durable/${actor}/snapshots?kind=state`)
  ok('snapshots listed', Array.isArray(snapList.data.snapshots) && snapList.data.snapshots.length >= 1, `${snapList.data.snapshots?.length} state snapshots`)

  // mutate state, then restore checkpoint → checkpointed values return
  await api('PATCH', `/api/flint/durable/${actor}/state`, { patch: { mood: 'DERAILED' } })
  const restore = await api('POST', `/api/flint/durable/${actor}/snapshots`, { op: 'restore', ref: ckRef })
  ok('checkpoint restore', restore.data.ok === true && restore.data.restore?.restored === true)
  const st3 = await api('GET', `/api/flint/durable/${actor}/state`)
  ok('restored state rolled back', st3.data.state?.mood !== 'DERAILED', `mood=${st3.data.state?.mood}`)

  // alarms — schedule a NOTE-mode wake-up 4s out, then wait and verify it fired
  const wk = await api('POST', `/api/flint/durable/${actor}/alarms`, { delayMs: 4000, prompt: 'durable alarm fired — hello from the future', mode: 'note' })
  ok('wake-up scheduled', wk.data.ok === true && typeof wk.data.at === 'number', `fires at ${new Date(wk.data.at).toISOString().slice(11, 19)}`)
  const wkInfo = await api('GET', `/api/flint/durable/${actor}/alarms`)
  ok('alarm readable (getAlarm)', typeof wkInfo.data.alarmAt === 'number' && wkInfo.data.alarmAt > Date.now() - 1000)

  console.log('    … waiting 7s for the durable alarm to fire …')
  await new Promise((r) => setTimeout(r, 7000))
  const after = await api('GET', `/api/flint/durable/${actor}/state`)
  ok('alarm fired (note landed in state)', after.data.state?.wakeNote === 'durable alarm fired — hello from the future', String(after.data.state?.wakeNote ?? '').slice(0, 40))
  const evAfter = await api('GET', `/api/flint/durable/${actor}/events?limit=5`)
  ok('alarm event-sourced', (evAfter.data.events ?? []).some((e) => String(e.topic ?? e.kind).includes('wake-up')) || JSON.stringify(evAfter.data.events ?? []).includes('wake-up'))

  // ── 2. shared spaces ─────────────────────────────────────────
  console.log('\n[2] Shared spaces — cross-agent KV, pub/sub, handoff')
  const sp = await api('POST', '/api/flint/spaces', { slug: 'e2e-space' })
  ok('space created', sp.data.ok === true)

  const kvPut = await api('POST', '/api/flint/spaces/e2e-space/kv', { key: 'shared/counter', value: 41 })
  ok('space KV put', kvPut.data.ok === true && typeof kvPut.data.entry?.version === 'number')
  const kvPut2 = await api('POST', '/api/flint/spaces/e2e-space/kv', { key: 'shared/counter', value: 42 })
  ok('LWW register version bumps', kvPut2.data.entry?.version > kvPut.data.entry?.version)
  const kvGet = await api('GET', '/api/flint/spaces/e2e-space/kv?key=shared/counter')
  ok('space KV get', kvGet.data.entry?.value === 42)
  const kvList = await api('GET', '/api/flint/spaces/e2e-space/kv?prefix=shared/')
  ok('space KV prefix list', kvList.data.entries?.length >= 1)

  const pub = await api('POST', '/api/flint/spaces/e2e-space/publish', { topic: 'research', payload: { finding: 'DOs port cleanly' }, from: actor })
  ok('space publish', pub.data.ok === true && pub.data.seq >= 1, `seq=${pub.data.seq}`)
  const hist = await api('GET', `/api/flint/durable/space:e2e-space/events?topic=research`)
  ok('publish event-sourced (cross-object read)', hist.data.events?.length >= 1)

  // SSE live watch
  const sse = await fetch(`${BASE}/api/flint/spaces/e2e-space/subscribe?topic=live`)
  ok('SSE subscribe opens (200, text/event-stream)', sse.status === 200 && (sse.headers.get('content-type') || '').includes('text/event-stream'))
  const reader = sse.body.getReader()
  let sseResolve
  const early = new Promise((r) => { sseResolve = r })
  const pending = (async () => {
    const chunks = []
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(Buffer.from(value).toString())
        const text = chunks.join('')
        if (text.includes('hello') && text.includes('event')) sseResolve(text)
      }
    } catch { /* stream closed */ }
    return chunks.join('')
  })()
  await new Promise((r) => setTimeout(r, 300))
  await api('POST', '/api/flint/spaces/e2e-space/publish', { topic: 'live', payload: { hello: 'sse' } })
  const sseText = await Promise.race([early, new Promise((r) => setTimeout(() => r('TIMEOUT'), 4000))])
  ok('SSE live fan-out (publish received)', sseText.includes('hello') && sseText.includes('event'), sseText.slice(0, 60).replace(/\n/g, '⏎'))
  try { await reader.cancel() } catch { /* noop */ }

  // handoff — agent A hands state + snapshot refs to agent B through the space
  const hoff = await api('POST', `/api/flint/durable/space:e2e-space/rpc`, {
    method: 'handoff',
    args: [{ fromAgent: actor, toAgent: actor, state: { phase: 'handoff-test', carry: 'ok' }, snapshotRefs: [ckRef].filter(Boolean), note: 'continuing on next node' }],
  })
  ok('handoff (state + snapshot refs, atomic)', hoff.data.ok === true && hoff.data.result?.seq >= 1)
  const inbox = await api('GET', `/api/flint/durable/${actor}/state`)
  const inboxKV = await api('GET', '/api/flint/spaces/e2e-space/kv?key=handoff:' + actor)
  ok('handoff KV bundle written', JSON.stringify(inboxKV.data.entry?.value ?? {}).includes('carry'))

  // ── 3. stateless sandbox mesh ─────────────────────────────────
  console.log('\n[3] Stateless sandbox mesh — free providers, snapshot continuity, failover')
  const provs = await api('GET', '/api/flint/mesh/providers')
  const local = provs.data.providers?.find((p) => p.id === 'local')
  ok('providers registry (7)', provs.data.providers?.length === 7, `${provs.data.providers?.length} providers, ${provs.data.summary?.freeAvailable} free available`)
  ok('local provider healthy + free', local?.status === 'healthy' && local?.costTier === 'free')

  // stateless run #1: files in → python exec → capture + snapshot-out
  const run1 = await api('POST', '/api/flint/mesh/exec', {
    command: 'python3 -c "import json; open(\'counter.json\',\'w\').write(json.dumps({\'n\': 7}))" && cat counter.json',
    files: { 'README.md': '# mesh run 1 — the counter starts at 7' },
    captureGlobs: ['*.json'],
    makeSnapshotOut: true,
    label: 'e2e-stateless-1',
    timeoutMs: 60_000,
  })
  const t1 = run1.data.task
  ok('mesh exec run 1 done (local, free)', run1.data.ok === true && t1?.exitCode === 0, `provider=${t1?.provider} ${(t1?.durationMs / 1000).toFixed(1)}s $${t1?.costUsd}`)
  ok('artifacts captured', t1?.artifacts?.['counter.json']?.includes('"n": 7'))
  ok('snapshot-out minted', !!t1?.snapshotOut, t1?.snapshotOut?.slice(0, 18) + '…')

  // stateless run #2: restore snapshot-in → the file from run 1 exists
  const run2 = await api('POST', '/api/flint/mesh/exec', {
    command: 'ls && cat README.md && python3 -c "import json; d=json.load(open(\'counter.json\')); print(\'counter-continues\', d[\'n\'] + 35)"',
    snapshotIn: t1.snapshotOut,
    label: 'e2e-stateless-2',
    timeoutMs: 60_000,
  })
  const t2 = run2.data.task
  ok('mesh exec run 2 restored snapshot-in (different sandbox, same state)', run2.data.ok === true && t2?.exitCode === 0)
  ok('state carried across sandboxes (counter-continues 42)', (t2?.stdout ?? '').includes('counter-continues 42'), t2.stdout?.trim().split('\n').at(-1))

  // failover surface: pinned unknown provider → clean error, no task crash
  const pinErr = await api('POST', '/api/flint/mesh/exec', { command: 'echo hi', provider: 'no-such-provider', timeoutMs: 15_000 })
  ok('pinned-unknown-provider → clean error', pinErr.status === 502 && /no healthy provider/.test(pinErr.data.error ?? ''))

  const tasks = await api('GET', '/api/flint/mesh/tasks?limit=10')
  ok('task ledger', Array.isArray(tasks.data.tasks) && tasks.data.tasks.length >= 2, `${tasks.data.tasks?.length} tasks`)

  // ── 4. durable objects listing + stats ───────────────────────
  console.log('\n[4] Observability')
  const objs = await api('GET', '/api/flint/durable/objects')
  const agentObj = objs.data.objects?.find((o) => o.name === actor)
  ok('durable objects listed (live)', objs.data.objects?.length >= 2 && agentObj?.live === true, `${objs.data.objects?.length} objects, stats.totalOps=${objs.data.stats?.totalOps}`)
  ok('storage metered', (objs.data.stats?.storageBytes ?? 0) > 0)

  // ── verdict ──────────────────────────────────────────────────
  console.log(`\n══ DURABLE MESH E2E: ${passed} passed · ${failed} failed ══`)
  if (failures.length) {
    console.log('failures:')
    for (const f of failures) console.log('  ✗ ' + f)
    process.exit(1)
  }
  console.log(`\nNext: restart the server and run scripts/test-durable-restart.mjs to verify state survives.`)
}

main().catch((e) => {
  console.error('E2E crashed:', e)
  process.exit(1)
})
