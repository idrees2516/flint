'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { toast } from 'sonner'
import { DollarSign, TrendingDown, Snowflake, PiggyBank, Loader2, ShieldAlert } from 'lucide-react'
import { api, usePoll, fmtUsd, fmtDur, type CostSummary } from './lib'
import { StatCard, SectionTitle } from './ui-bits'
import { cn } from '@/lib/utils'

export function CostView() {
  const cost = usePoll<CostSummary>('/cost', 5000)
  const [limit, setLimit] = useState<number | null>(null)
  const [threshold, setThreshold] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)

  const d = cost.data
  const budget = d?.budget
  const limitVal = limit ?? budget?.monthlyLimitUsd ?? 20
  const threshVal = threshold ?? budget?.alertThreshold ?? 0.8
  const burnPct = budget ? Math.min(100, (budget.spentUsd / budget.monthlyLimitUsd) * 100) : 0

  const save = async () => {
    setSaving(true)
    try {
      await api('/cost', { method: 'POST', body: JSON.stringify({ monthlyLimitUsd: limitVal, alertThreshold: threshVal }) })
      toast.success('Budget updated')
      cost.refresh()
    } catch (e) {
      toast.error(String((e as Error).message ?? e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <SectionTitle title="Cost center" sub="Per-second metering · waste detection · budget guardrails — the anti-surprise-bill department" />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard icon={DollarSign} label="Spend to date" value={fmtUsd(d?.totalCost ?? 0)} sub={`${fmtDur(d?.totalSeconds ?? 0)} billed`} />
        <StatCard icon={TrendingDown} label="vs boat.dev" value={fmtUsd(d?.savings.boat ?? 0)} sub="saved, same workload" accent="text-emerald-400" />
        <StatCard icon={TrendingDown} label="vs Vercel" value={fmtUsd(d?.savings.vercel ?? 0)} sub="saved, same workload" accent="text-emerald-400" />
        <StatCard icon={Snowflake} label="Hibernation savings" value={fmtUsd((d?.waste ?? []).reduce((a, w) => a + w.savingsPerDay, 0))} sub="per day if optimized" accent="text-sky-300" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        {/* spend table */}
        <Card className="border-zinc-800 bg-zinc-900/50">
          <CardContent className="p-0">
            <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3.5">
              <span className="text-sm font-semibold text-zinc-200">Spend by sandbox</span>
              <Badge variant="outline" className="border-zinc-800 font-mono text-[10px] text-zinc-500">metered 1s</Badge>
            </div>
            <div className="divide-y divide-zinc-800/60">
              {(d?.spend ?? []).length === 0 && <div className="px-5 py-10 text-center text-sm text-zinc-600">No metering events yet.</div>}
              {(d?.spend ?? []).map((s) => {
                const max = Math.max(...(d?.spend ?? []).map((x) => x.cost), 0.0001)
                return (
                  <div key={s.id} className="px-5 py-3">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-sm text-zinc-200">{s.name}</span>
                      <span className="font-mono text-sm text-amber-400">{fmtUsd(s.cost)}</span>
                    </div>
                    <div className="mt-1.5 flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-800">
                        <div className="h-full rounded-full bg-gradient-to-r from-amber-400 to-orange-500" style={{ width: `${(s.cost / max) * 100}%` }} />
                      </div>
                      <span className="font-mono text-[10px] text-zinc-600">{fmtDur(s.seconds)}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          {/* budget */}
          <Card className="border-zinc-800 bg-zinc-900/50">
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-sm font-semibold text-zinc-200"><PiggyBank className="h-4 w-4 text-amber-500" /> Budget</span>
                <span className={cn('font-mono text-sm', burnPct > 80 ? 'text-red-400' : burnPct > 50 ? 'text-amber-400' : 'text-emerald-400')}>
                  {fmtUsd(budget?.spentUsd ?? 0)} / {fmtUsd(limitVal)}
                </span>
              </div>
              <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-zinc-800">
                <div
                  className={cn('h-full rounded-full transition-all', burnPct > 80 ? 'bg-red-500' : 'bg-gradient-to-r from-amber-400 to-orange-500')}
                  style={{ width: `${burnPct}%` }}
                />
              </div>
              <div className="mt-4 space-y-4">
                <div>
                  <div className="flex justify-between text-xs"><span className="text-zinc-500">Monthly limit</span><span className="font-mono text-amber-400">${limitVal}</span></div>
                  <Slider value={[limitVal]} min={1} max={200} step={1} onValueChange={([v]) => setLimit(v)} className="mt-1.5" />
                </div>
                <div>
                  <div className="flex justify-between text-xs"><span className="text-zinc-500">Alert threshold</span><span className="font-mono text-amber-400">{Math.round(threshVal * 100)}%</span></div>
                  <Slider value={[threshVal]} min={10} max={95} step={5} onValueChange={([v]) => setThreshold(v)} className="mt-1.5" />
                </div>
                <div className="flex gap-2">
                  <Button size="sm" disabled={saving} onClick={() => void save()} className="flex-1 bg-amber-500 font-semibold text-zinc-950 hover:bg-amber-400">
                    {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null} Save budget
                  </Button>
                  <Button
                    size="sm" variant="outline" disabled={saving}
                    className="border-zinc-700 bg-zinc-950/60 text-xs text-zinc-400"
                    onClick={() => void api('/cost', { method: 'POST', body: JSON.stringify({ resetSpent: true }) }).then(() => { toast.success('Counters reset'); cost.refresh() })}
                  >
                    Reset counters
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* waste detection */}
          <Card className="border-zinc-800 bg-zinc-900/50">
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-sm font-semibold text-zinc-200"><ShieldAlert className="h-4 w-4 text-amber-500" /> Waste detector</span>
                <Badge variant="outline" className="border-zinc-800 font-mono text-[10px] text-zinc-500">20s sweep</Badge>
              </div>
              <div className="mt-3 space-y-2">
                {(d?.waste ?? []).length === 0 ? (
                  <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/[0.05] px-3 py-4 text-center text-xs text-emerald-300">
                    Fleet is clean — no idle burn detected.
                  </div>
                ) : (
                  (d?.waste ?? []).map((w) => (
                    <div key={w.id} className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-3">
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-xs text-zinc-200">{w.name}</span>
                        <span className="font-mono text-xs text-amber-400">-{fmtUsd(w.savingsPerDay)}/day</span>
                      </div>
                      <div className="mt-1 text-[11px] text-zinc-500">{w.recommendation}</div>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* pricing card */}
      <Card className="border-zinc-800 bg-zinc-900/50">
        <CardContent className="p-5">
          <span className="text-sm font-semibold text-zinc-200">Rate card — the whole thing</span>
          <div className="mt-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4 lg:grid-cols-7">
            {[
              { k: 'on-demand / vCPU-s', v: '$0.00000111' },
              { k: 'spot / vCPU-s', v: '$0.00000042' },
              { k: 'RAM / GB-s', v: '$0.00000022' },
              { k: 'hibernate / GB-s', v: '$0.000000008' },
              { k: 'disk / GB-hr', v: '$0.00002' },
              { k: 'snapshot / GB-hr', v: '$0.000015' },
              { k: 'fork (O(1))', v: '$0.0001 flat' },
            ].map((r) => (
              <div key={r.k} className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-2.5">
                <div className="font-mono text-[13px] font-semibold text-amber-400">{r.v}</div>
                <div className="mt-0.5 text-[10px] text-zinc-600">{r.k}</div>
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs leading-relaxed text-zinc-500">
            2 vCPU · 4 GB running = <span className="font-mono text-amber-400">$0.008/hr</span>. Hibernated sandboxes cost
            ~$0.00000003/s (snapshot storage only). Stopped = exactly $0. Every number metered per second, batched to the
            ledger every 5s. No rounding in our favor, ever.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
