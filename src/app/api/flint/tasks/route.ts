import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { runAgentTask } from '@/lib/flint/agent'
import { bus } from '@/lib/flint/events'

export async function GET() {
  const tasks = await db.agentTask.findMany({
    include: { sandbox: { select: { id: true, name: true, status: true } }, _count: { select: { steps: true } } },
    orderBy: { createdAt: 'desc' },
    take: 40,
  })
  return NextResponse.json({ tasks })
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const prompt = String(body.prompt ?? '').trim()
  if (!prompt) return NextResponse.json({ error: 'prompt required' }, { status: 400 })

  const strategy = body.strategy === 'dag' ? 'dag' : 'react'
  const sandboxId = body.sandboxId ? String(body.sandboxId) : null
  if (sandboxId) {
    const sbx = await db.sandbox.findUnique({ where: { id: sandboxId } })
    if (!sbx) return NextResponse.json({ error: 'sandbox not found' }, { status: 404 })
  }

  const task = await db.agentTask.create({
    data: {
      name: String(body.name ?? prompt.slice(0, 48)),
      prompt,
      sandboxId,
      strategy,
      model: 'glm-4.7',
      maxSteps: Math.max(2, Math.min(24, Number(body.maxSteps ?? 8))),
      toolConcurrency: Math.max(1, Math.min(8, Number(body.toolConcurrency ?? 4))),
      status: 'queued',
    },
  })
  bus.emit({ type: 'task:queued', source: 'agent', message: `Task "${task.name}" queued (${strategy})`, refId: task.id })

  // fire-and-forget — progress streams over the event bus
  void runAgentTask(task.id).catch((e) => console.error('[flint:agent]', e))

  return NextResponse.json({ task })
}
