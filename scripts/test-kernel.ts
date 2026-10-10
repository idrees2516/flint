// Smoke test for the Flint kernel: spawn, eval, host calls, snapshot/restore.
import { kernelManager, bootKernels } from '../src/lib/flint/kernel'

kernelManager.registerHostFn('websearch', async (_sid, args) => {
  const q = String(args[0] ?? '')
  return [`result-1 for ${q}`, 'result-2']
})
kernelManager.registerHostFn('done', async (_sid, args) => ({ done: true, summary: String(args[0] ?? '') }))

async function main() {
  bootKernels()
  const sid = 'test-session-1'

  // 1. basic persistence
  const r1 = await kernelManager.eval(sid, 'x = 41\nx + 1')
  console.log('eval1:', JSON.stringify({ ok: r1.ok, stdout: r1.stdout.trim() }))
  if (!r1.ok || !r1.stdout.includes('42')) throw new Error('FAIL: eval1')

  // 2. variable persists across evals
  const r2 = await kernelManager.eval(sid, 'x * 10')
  console.log('eval2:', r2.stdout.trim())
  if (!r2.stdout.includes('410')) throw new Error('FAIL: persistence')

  // 3. host call (websearch) from kernel
  const r3 = await kernelManager.eval(sid, 'res = websearch("flint platform")\nstr(res[0])')
  console.log('eval3:', r3.stdout.trim())
  if (!r3.ok || !r3.stdout.includes('result-1 for flint platform')) throw new Error('FAIL: host call')

  // 4. bash + files
  const r4 = await kernelManager.eval(sid, 'h = bash("echo hello-flint > note.txt && cat note.txt")\nh.output(5)')
  console.log('eval4:', r4.ok, r4.stdout.trim().slice(0, 100))
  if (!r4.ok || !r4.stdout.includes('hello-flint')) throw new Error('FAIL: bash')

  // 5. snapshot → park → eval again (lazy restore path)
  const snap = await kernelManager.snapshot(sid)
  if (!snap) throw new Error('FAIL: snapshot')
  console.log('snapshot vars:', Object.keys(snap.manifest).join(','))
  await kernelManager.park(sid)
  const r5 = await kernelManager.eval(sid, 'x + 1')
  console.log('eval5 (post-restore):', r5.stdout.trim())

  // 6. vars listing
  const vars = await kernelManager.vars(sid)
  console.log('vars:', Object.keys(vars).join(','))

  console.log('ALL KERNEL TESTS PASSED')
  process.exit(0)
}

main().catch((e) => {
  console.error('TEST FAILED:', e)
  process.exit(1)
})
