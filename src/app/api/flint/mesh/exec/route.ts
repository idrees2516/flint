// POST /api/flint/mesh/exec — stateless execution on the sandbox mesh.
//
// The scale primitive: snapshot-in → acquire sandbox (free provider
// first) → restore files → exec → capture artifacts → snapshot-out
// → recycle. Provider failures fail over automatically.
//
// body:
//   command       string   shell command (or code when language=python/node)
//   language?     "bash" | "python" | "node"
//   files?        { relativePath: content }   materialized before exec
//   env?          { VAR: value }
//   timeoutMs?    number (default 120000)
//   captureGlobs? ["*.json", "out/*.csv"]     files captured back
//   snapshotIn?   ref from a previous makeSnapshotOut run
//   makeSnapshotOut? bool
//   provider?     pin: local | docker | instabox | e2b | daytona | github-actions | jupyter
//   label?        string
//   background?   bool → 202 { taskId } immediately, poll /mesh/tasks
import { NextRequest, NextResponse } from 'next/server'
import { bootMesh, mesh } from '@/lib/flint/mesh'

export const maxDuration = 300

export async function POST(req: NextRequest) {
  bootMesh()
  const body = await req.json().catch(() => ({}))
  const command = String(body.command ?? '')
  if (!command) return NextResponse.json({ error: 'command required' }, { status: 400 })

  const spec = {
    command,
    language: (body.language as 'bash' | 'python' | 'node') ?? 'bash',
    cwd: body.cwd ? String(body.cwd) : undefined,
    env: (body.env as Record<string, string>) ?? undefined,
    files: (body.files as Record<string, string>) ?? undefined,
    timeoutMs: Number(body.timeoutMs ?? 120_000),
    captureGlobs: (body.captureGlobs as string[]) ?? undefined,
    snapshotIn: body.snapshotIn ? String(body.snapshotIn) : undefined,
    makeSnapshotOut: body.makeSnapshotOut === true,
    provider: body.provider ? String(body.provider) : undefined,
    label: body.label ? String(body.label) : 'api-mesh-exec',
  }

  if (body.background === true) {
    // fire-and-forget — poll /api/flint/mesh/tasks for the result
    void mesh.runTask(spec).catch(() => {})
    return NextResponse.json({ ok: true, queued: true }, { status: 202 })
  }

  try {
    const result = await mesh.runTask(spec)
    return NextResponse.json({ ok: true, task: result })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    )
  }
}
