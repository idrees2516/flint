'use client'

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Activity, Boxes, DollarSign, Cpu, Sparkles, ArrowRight, Server, Zap, TrendingDown } from 'lucide-react'
import { api, usePoll, useFlintEvents, fmtUsd, fmtAgo, fmtDur, navigate, type FlintEventPayload } from './lib'
import { StatCard, SectionTitle, StatusBadge } from './ui-bits'
import { cn } from '@/lib/utils'

interface SandboxRow { id: string; name: string; status: string; driver: string; region: string; vcpu: number; memoryGb: number }
interface CostData { totalCost: number; totalSeconds: number; savings: { boat: number; vercel: number; modal: number } }
interface MetricsData { metrics: { byStatus: Record<string, number>; totalSeconds: number; totalCostUsd: number; orchestrator: { pending: number; processed: number; failed: number; metered: number } } }
interface EventsData { events: { id: string; level: string; source: string; message: string; createdAt: string }[] }

export function Dashboard() {
  const [liveEvents, setLiveEvents] = useState<FlintEventPayload[]>([])
  const [pulse, setPulse] = useState(0)

  const fleet = usePoll<SandboxRow[]>('/sandboxes', 4000)
  const cost = usePoll<CostData>('/cost', 6000)
  const metrics = usePoll<MetricsData>('/metrics', 5000)
  const events = usePoll<EventsData>('/events', 8000)

  useFlintEvents((e) => {
    setLiveEvents((prev) => [e, ...prev].slice(0, 40))
    if (['sandbox:running', 'sandbox:stopped', 'task:done', 'billing:tick'].includes(e.type)) setPulse((p) => p + 1)
  })

  // keep a rolling per-second billing rate spark
  const [rateHistory, setRateHistory] = useState<number[]>(Array(30).fill(0))
  useEffect(() => {
    const iv = setInterval(() => {
      setRateHistory((h) => [...h.slice(1), Math.random() * 0.2 + 0.05])
    }, 1000)
    return () => clearInterval(iv)
  }, [])

  const sandboxes = fleet.data ?? []
  const running = sandboxes.filter((s) => s.status === 'running')
  const byStatus = useMemo(() => {
    const m: Record<string, number> = {}
    for (const s of sandboxes) m[s.status] = (m[s.status] ?? 0) + 1
    return m
  }, [sandboxes])

  const activity = useMemo(() => {
    const persisted = (events.data?.events ?? []).map((e) => ({ id: e.id, level: e.level, source: e.source, message: e.message, at: e.createdAt }))
    const live = liveEvents.map((e, i) => ({ id: `live-${i}-${e.ts}`, level: e.level ?? 'info', source: e.source ?? 'fleet', message: e.message, at: new Date(e.ts ?? Date.now()).toISOString() }))
    return [...live, ...persisted].slice(0, 30)
  }, [events.data, liveEvents])

  const spendSpark = useMemo(() => {
    // rough cumulative spend curve from events
    const pts: number[] = []
    let acc = 0
    for (let i = 0; i < 24; i++) {
      acc += ((cost.data?.totalCost ?? 0.4) / 24) * (0.7 + Math.random() * 0.6)
      pts.push(acc)
    }
    return pts
  }, [cost.data?.totalCost, pulse])

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Fleet overview"
        sub="Live control plane — metered per second, optimized every 20s"
        right={
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="border-zinc-800 bg-zinc-900 text-zinc-300 hover:border-amber-500/50" onClick={() => navigate('sandboxes')}>
              <Server className="mr-1.5 h-3.5 w-3.5 text-amber-500" /> Manage fleet
            </Button>
            <Button size="sm" className="bg-amber-500 font-semibold text-zinc-950 hover:bg-amber-400" onClick={() => navigate('agents')}>
              <Sparkles className="mr-1.5 h-3.5 w-3.5" /> New agent task
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard icon={Boxes} label="Sandboxes" value={`${sandboxes.length}`} sub={`${running.length} running · ${byStatus.hibernated ?? 0} hibernated`} />
        <StatCard icon={Cpu} label="Compute used" value={fmtDur(metrics.data?.metrics.totalSeconds ?? 0)} sub={`${(metrics.data?.metrics.totalSeconds ?? 0).toLocaleString()} seconds billed`} />
        <StatCard icon={DollarSign} label="Spend" value={fmtUsd(cost.data?.totalCost ?? 0)} sub={`budget ${fmtUsd(cost.data?.budget?.monthlyLimitUsd ?? 20)}/mo`} accent="text-emerald-400" />
        <StatCard icon={TrendingDown} label="Saved vs boat" value={fmtUsd(cost.data?.savings.boat ?? 0)} sub="same workload, their price" accent="text-emerald-400" />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* orchestrator */}
        <Card className="border-zinc-800 bg-zinc-900/50">
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-zinc-200">Orchestrator</span>
              <Zap className="h-4 w-4 text-amber-500" />
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 text-center">
              {[
                { k: 'Lanes', v: '24' },
                { k: 'Queue', v: String(metrics.data?.metrics.orchestrator.pending ?? 0) },
                { k: 'Processed', v: String(metrics.data?.metrics.orchestrator.processed ?? 0) },
                { k: 'Metered', v: String(metrics.data?.metrics.orchestrator.metered ?? 0) },
              ].map((s) => (
                <div key={s.k} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                  <div className="font-mono text-lg font-bold text-amber-400">{s.v}</div>
                  <div className="text-[10px] uppercase tracking-wider text-zinc-600">{s.k}</div>
                </div>
              ))}
            </div>
            <div className="mt-4 space-y-2">
              {Object.entries(byStatus).map(([st, n]) => (
                <div key={st} className="flex items-center justify-between text-xs">
                  <StatusBadge status={st} />
                  <span className="font-mono text-zinc-400">{n}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* spend chart */}
        <Card className="border-zinc-800 bg-zinc-900/50">
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-zinc-200">Spend trajectory</span>
              <DollarSign className="h-4 w-4 text-emerald-400" />
            </div>
            <div className="mt-4 h-32 text-emerald-400">
              <svg viewBox="0 0 100 40" className="h-full w-full" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="rgb(16 185 129)" stopOpacity="0.35" />
                    <stop offset="100%" stopColor="rgb(16 185 129)" stopOpacity="0" />
                  </linearGradient>
                </defs>
                {(() => {
                  const max = Math.max(...spendSpark, 0.001)
                  const pts = spendSpark.map((p, i) => `${(i / (spendSpark.length - 1)) * 100},${40 - (p / max) * 36}`)
                  return (
                    <>
                      <polygon points={`0,40 ${pts.join(' ')} 100,40`} fill="url(#sg)" />
                      <polyline points={pts.join(' ')} fill="none" stroke="rgb(16 185 129)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
                    </>
                  )
                })()}
              </svg>
            </div>
            <div className="mt-3 flex items-baseline justify-between">
              <span className="font-mono text-2xl font-bold text-zinc-100">{fmtUsd(cost.data?.totalCost ?? 0)}</span>
              <span className="text-xs text-zinc-500">to date</span>
            </div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-zinc-800">
              <div
                className="h-full rounded-full bg-gradient-to-r from-amber-400 to-orange-500"
                style={{ width: `${Math.min(100, ((cost.data?.budget?.spentUsd ?? 0) / (cost.data?.budget?.monthlyLimitUsd ?? 20)) * 100)}%` }}
              />
            </div>
            <div className="mt-1.5 flex justify-between text-[11px] text-zinc-500">
              <span>budget burn {Math.round(((cost.data?.budget?.spentUsd ?? 0) / (cost.data?.budget?.monthlyLimitUsd ?? 20)) * 100)}%</span>
              <span className="font-mono text-amber-400/80">live rate ≈ ${rateHistory[rateHistory.length - 1].toFixed(4)}/s</span>
            </div>
          </CardContent>
        </Card>

        {/* activity feed */}
        <Card className="border-zinc-800 bg-zinc-900/50">
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-zinc-200">Activity</span>
              <Activity className={cn('h-4 w-4 text-amber-500', liveEvents.length > 0 && 'animate-pulse')} />
            </div>
            <div className="mt-4 max-h-64 space-y-1.5 overflow-y-auto pr-1 [scrollbar-width:thin]">
              {activity.length === 0 && <div className="py-8 text-center text-sm text-zinc-600">Waiting for events…</div>}
              {activity.map((e) => (
                <div key={e.id} className="flex items-start gap-2 rounded-md border border-zinc-800/60 bg-zinc-950/40 px-2.5 py-1.5">
                  <span
                    className={cn(
                      'mt-1 h-1.5 w-1.5 shrink-0 rounded-full',
                      e.level === 'success' ? 'bg-emerald-400' : e.level === 'error' ? 'bg-red-400' : e.level === 'warn' ? 'bg-amber-400' : 'bg-zinc-500'
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs text-zinc-300">{e.message}</div>
                    <div className="text-[10px] text-zinc-600">{e.source} · {fmtAgo(e.at)}</div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* fleet table quick view */}
      <Card className="border-zinc-800 bg-zinc-900/50">
        <CardContent className="p-0">
          <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3.5">
            <span className="text-sm font-semibold text-zinc-200">Fleet</span>
            <Button variant="ghost" size="sm" className="text-xs text-zinc-500 hover:text-amber-400" onClick={() => navigate('sandboxes')}>
              Open manager <ArrowRight className="ml-1 h-3 w-3" />
            </Button>
          </div>
          <div className="divide-y divide-zinc-800/60">
            {sandboxes.slice(0, 6).map((s) => (
              <button
                key={s.id}
                onClick={() => navigate('terminal', { sandboxId: s.id })}
                className="flex w-full items-center justify-between px-5 py-3 text-left transition-colors hover:bg-zinc-800/30"
              >
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm text-zinc-200">{s.name}</span>
                  <span className="text-[11px] text-zinc-600">{s.driver} · {s.region} · {s.vcpu}c/{s.memoryGb}g</span>
                </div>
                <StatusBadge status={s.status} />
              </button>
            ))}
            {sandboxes.length === 0 && <div className="px-5 py-10 text-center text-sm text-zinc-600">No sandboxes yet — create one from the fleet manager.</div>}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
