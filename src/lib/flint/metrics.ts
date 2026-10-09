// ─────────────────────────────────────────────────────────────
// Flint · Metrics — per-sandbox sampled resource metrics with
// an in-memory ring cache (hot reads never touch the DB).
// ─────────────────────────────────────────────────────────────
import { db } from '@/lib/db'
import { getDriver, counterState } from './drivers'

const g = globalThis as unknown as { __flintMetrics?: Map<string, { at: number; data: Record<string, unknown> }> }
const cache = g.__flintMetrics ?? (g.__flintMetrics = new Map())
const TTL_MS = 3000

export async function fleetMetricsFor(sandboxId: string): Promise<Record<string, unknown>> {
  const cached = cache.get(sandboxId)
  if (cached && Date.now() - cached.at < TTL_MS) return cached.data
  const sbx = await db.sandbox.findUnique({ where: { id: sandboxId }, include: { template: true } })
  if (!sbx) throw new Error('sandbox not found')
  const driver = getDriver(sbx.driver)
  const counters = counterState(sbx.id)
  const data = await driver.metrics(
    {
      id: sbx.id,
      name: sbx.name,
      templateSlug: sbx.template?.slug,
      vcpu: sbx.vcpu,
      memoryGb: sbx.memoryGb,
      diskGb: sbx.diskGb,
      region: sbx.region,
    },
    { startedAt: sbx.startedAt, lastActiveAt: sbx.lastActiveAt, ...counters }
  )
  cache.set(sandboxId, { at: Date.now(), data })
  return data
}
