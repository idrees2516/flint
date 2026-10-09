import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { computeCostUsd, PRICING, savingsVs } from '@/lib/flint/pricing'

export async function GET() {
  const [events, budget, sandboxes] = await Promise.all([
    db.usageEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 500, include: { sandbox: { select: { name: true } } } }),
    db.budget.findFirst(),
    db.sandbox.findMany({ select: { id: true, name: true, status: true, vcpu: true, memoryGb: true, diskGb: true, lastActiveAt: true, hibernateAfterMin: true, createdAt: true } }),
  ])

  // aggregate per-sandbox spend
  const perSandbox = new Map<string, { name: string; seconds: number; cost: number }>()
  for (const ev of events) {
    const k = ev.sandboxId
    const row = perSandbox.get(k) ?? { name: ev.sandbox?.name ?? k, seconds: 0, cost: 0 }
    row.seconds += ev.seconds
    row.cost += ev.costUsd
    perSandbox.set(k, row)
  }
  const spend = [...perSandbox.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.cost - a.cost)

  const totalCost = spend.reduce((a, s) => a + s.cost, 0)
  const totalSeconds = spend.reduce((a, s) => a + s.seconds, 0)

  // cost optimizer — waste detection
  const now = Date.now()
  const waste = sandboxes
    .filter((s) => s.status === 'running')
    .map((s) => {
      const idleMin = (now - new Date(s.lastActiveAt).getTime()) / 60000
      const burnPerHour = computeCostUsd({ vcpu: s.vcpu, memoryGb: s.memoryGb, seconds: 3600 })
      return { id: s.id, name: s.name, idleMin: Math.round(idleMin), hibernateAfterMin: s.hibernateAfterMin, burnPerHour }
    })
    .filter((s) => s.idleMin > 5)
    .map((s) => ({
      ...s,
      recommendation:
        s.idleMin >= s.hibernateAfterMin
          ? 'hibernating now — auto-watchdog will act on next sweep'
          : `idle ${s.idleMin}m · auto-hibernate at ${s.hibernateAfterMin}m`,
      savingsPerDay: (s.burnPerHour * 24 * 0.92),
    }))

  // savings projection vs competitors (same 2vCPU·4GB workload)
  const hoursPriced = Math.max(1, totalSeconds / 3600)
  const savings = {
    boat: savingsVs(0.018, hoursPriced),
    vercel: savingsVs(0.151, hoursPriced),
    modal: savingsVs(0.169, hoursPriced),
  }

  return NextResponse.json({
    pricing: PRICING,
    budget: budget ?? { monthlyLimitUsd: 20, alertThreshold: 0.8, spentUsd: 0 },
    spend,
    totalCost,
    totalSeconds,
    waste,
    savings,
    monthlyProjection: {
      hoursPriced,
      flint: computeCostUsd({ vcpu: 2, memoryGb: 4, seconds: hoursPriced * 3600 }),
    },
  })
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const budget = await db.budget.findFirst()
  const data = {
    monthlyLimitUsd: Math.max(1, Math.min(10000, Number(body.monthlyLimitUsd ?? 20))),
    alertThreshold: Math.max(0.1, Math.min(1, Number(body.alertThreshold ?? 0.8))),
    ...(body.resetSpent ? { spentUsd: 0, alertsSent: 0 } : {}),
  }
  const updated = budget
    ? await db.budget.update({ where: { id: budget.id }, data })
    : await db.budget.create({ data })
  return NextResponse.json({ budget: updated })
}
