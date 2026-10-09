// ─────────────────────────────────────────────────────────────
// Flint · Pricing — per-second metering, aggressively cheaper
// than boat.dev / Modal / Vercel Sandbox.
//
//   boat.dev  : $0.018/hr for 2 vCPU / 4 GB   (~$0.000005 / vCPU-sec)
//   Flint     : $0.008/hr for 2 vCPU / 4 GB   + idle hibernate + spot tier
// ─────────────────────────────────────────────────────────────

export interface FlintPricing {
  // per-second, per-vCPU compute rates (USD)
  onDemandPerVcpuSec: number
  spotPerVcpuSec: number // preemptible tier — 62% cheaper
  memoryPerGbSec: number
  hibernatePerGbSec: number // snapshot-only storage while hibernated
  storagePerGbHr: number
  snapshotPerGbHr: number
  forkFee: number // O(1) COW fork — flat micro-fee
  llmInPer1k: number
  llmOutPer1k: number
  freeTierSeconds: number
}

export const PRICING: FlintPricing = {
  // 2 vCPU/4GB ≈ $0.008/hr → 0.008/3600/2 per vCPU-sec
  onDemandPerVcpuSec: 0.00000111,
  spotPerVcpuSec: 0.00000042,
  memoryPerGbSec: 0.00000022,
  hibernatePerGbSec: 0.000000008,
  storagePerGbHr: 0.00002,
  snapshotPerGbHr: 0.000015,
  forkFee: 0.0001,
  llmInPer1k: 0.0022,
  llmOutPer1k: 0.0088,
  freeTierSeconds: 3_000_000, // 3M compute-seconds/mo included
}

export function computeCostUsd(opts: {
  vcpu: number
  memoryGb: number
  seconds: number
  tier?: 'on-demand' | 'spot'
  state?: 'running' | 'hibernated'
  diskGb?: number
}): number {
  const { vcpu, memoryGb, seconds, tier = 'on-demand', state = 'running', diskGb = 20 } = opts
  if (state === 'hibernated') {
    return seconds * (memoryGb * PRICING.hibernatePerGbSec + diskGb * (PRICING.storagePerGbHr / 3600))
  }
  const vcpuRate = tier === 'spot' ? PRICING.spotPerVcpuSec : PRICING.onDemandPerVcpuSec
  return seconds * (vcpu * vcpuRate + memoryGb * PRICING.memoryPerGbSec)
}

export const fmtUsd = (v: number): string => {
  if (v === 0) return '$0.00'
  if (v < 0.01) return `$${v.toFixed(5)}`
  if (v < 1) return `$${v.toFixed(4)}`
  return `$${v.toFixed(2)}`
}

export const monthlyProjection = (opts: {
  vcpu: number
  memoryGb: number
  hoursPerMonth: number
  tier?: 'on-demand' | 'spot'
}): number => computeCostUsd({ ...opts, seconds: opts.hoursPerMonth * 3600 })

/** Head-to-head comparison table (boat.dev public pricing, Oct 2026). */
export const COMPETITORS = [
  {
    name: 'Flint',
    hourly2x4: 0.008,
    perSecond: true,
    freeWhenStopped: true,
    autoHibernate: true,
    fork: 'O(1) COW, ~0ms',
    concurrentCap: 'Unlimited (autoscaling pools)',
    sshDocker: true,
    agentRuntime: true,
    monthlyMin: 15,
  },
  {
    name: 'boat.dev',
    hourly2x4: 0.018,
    perSecond: true,
    freeWhenStopped: true,
    autoHibernate: false,
    fork: 'Fast fork',
    concurrentCap: '2,000 VMs',
    sshDocker: true,
    agentRuntime: false,
    monthlyMin: 20,
  },
  {
    name: 'Vercel Sandbox',
    hourly2x4: 0.151,
    perSecond: false,
    freeWhenStopped: true,
    autoHibernate: false,
    fork: '—',
    concurrentCap: '10 concurrent',
    sshDocker: false,
    agentRuntime: false,
    monthlyMin: 20,
  },
  {
    name: 'Modal',
    hourly2x4: 0.169,
    perSecond: true,
    freeWhenStopped: true,
    autoHibernate: true,
    fork: 'gVisor layer',
    concurrentCap: 'Autoscale',
    sshDocker: true,
    agentRuntime: false,
    monthlyMin: 0,
  },
] as const

export const savingsVs = (competitorHourly: number, flintHours: number): number => {
  const flint = monthlyProjection({ vcpu: 2, memoryGb: 4, hoursPerMonth: flintHours })
  return competitorHourly * flintHours - flint
}
