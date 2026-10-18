// Agent-level integration: one RLM turn exercising durable + mesh host fns
const BASE = 'http://localhost:3000'
const api = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, data: await res.json().catch(() => ({})) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function main() {
  await api('GET', '/api/flint/bootstrap')
  const { data: session } = await api('POST', '/api/flint/sessions', { name: 'mesh-integration' })
  const sid = session.session?.id ?? session.id
  console.log('session', sid)
  const prompt = `Do these steps in order with code:
1. state = host("durable_state", "put", {"phase": "mesh-integrated", "discovered": len(host("mesh_providers"))})
2. provs = host("mesh_providers"); print("free providers:", [p["id"] for p in provs if p["free"]])
3. r = host("mesh_exec", "python3 -c 'import json,math; print(json.dumps({\\\\"beads\\\\": math.comb(10,3), \\\\"phi\\\\": (1+5**0.5)/2}))'", {"language": "bash", "label": "agent-mesh", "timeoutMs": 60000})
4. print("mesh result:", r["stdout"].strip(), "exit:", r["exitCode"], "provider:", r["provider"])
5. host("space_publish", "flint-agents", "mesh-activity", {"by": "mesh-integration", "provider": r["provider"], "ok": r["exitCode"] == 0})
6. seq = host("space_subscribe", "flint-agents", "mesh-activity", 0); print("space events seen:", len(seq))
7. flint_done("durable state put, providers listed, mesh exec on " + r["provider"] + ", space published+subscribed")`
  const t0 = Date.now()
  const turn = await api('POST', `/api/flint/sessions/${sid}/messages`, { text: prompt })
  if (turn.status !== 200) { console.log('turn start failed', turn.status, turn.data); process.exit(1) }
  // poll for completion
  let final = ''
  for (let i = 0; i < 90; i++) {
    await sleep(2000)
    const s = await api('GET', `/api/flint/sessions/${sid}`)
    const sess = s.data.session ?? {}
    if ((sess.status === 'idle' || sess.status === 'done' || sess.status === 'error') && sess.lastMessage) { final = sess.lastMessage; break }
  }
  console.log(`turn finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  console.log('final:', final.slice(0, 300))
  const st = await api('GET', `/api/flint/durable/agent:${sid}/state`)
  console.log('durable phase:', st.data.state?.phase, '| providers discovered:', st.data.state?.discovered)
  const pub = await api('GET', '/api/flint/durable/space:flint-agents/events?topic=mesh-activity&limit=3')
  console.log('space mesh-activity events:', (pub.data.events ?? []).length)
  const okAll = final.length > 0 && st.data.state?.phase === 'mesh-integrated' && (pub.data.events ?? []).length >= 1
  console.log(okAll ? '══ AGENT×MESH INTEGRATION: PASS ══' : '══ AGENT×MESH INTEGRATION: FAIL ══')
  process.exit(okAll ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
