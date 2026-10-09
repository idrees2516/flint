'use client'

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Slider } from '@/components/ui/slider'
import { Input } from '@/components/ui/input'
import {
  Sparkles, Zap, Copy, Gauge, GitFork, Camera, Clock, ShieldCheck, Boxes, ArrowRight, Check, X,
  ChevronRight, Terminal,
} from 'lucide-react'
import { api, fmtUsd, navigate } from './lib'
import { cn } from '@/lib/utils'

const COMPETITORS = [
  { name: 'Flint', hourly: 0.008, perSecond: true, freeStopped: true, autoHibernate: true, fork: 'O(1) COW ~0ms', cap: 'Unlimited', agents: true, sshDocker: true, desktop: true, kvm: true, highlight: true },
  { name: 'boat.dev', hourly: 0.018, perSecond: true, freeStopped: true, autoHibernate: false, fork: 'Fast fork', cap: '2,000 VMs', agents: false, sshDocker: true, desktop: true, kvm: true },
  { name: 'Vercel Sandbox', hourly: 0.151, perSecond: false, freeStopped: true, autoHibernate: false, fork: '—', cap: '10 / team', agents: false, sshDocker: false, desktop: false, kvm: false },
  { name: 'Modal', hourly: 0.169, perSecond: true, freeStopped: true, autoHibernate: true, fork: 'gVisor layers', cap: 'Autoscale', agents: false, sshDocker: true, desktop: false, kvm: false },
]

const FEATURES = [
  { icon: Zap, title: 'Per-second billing, $0.008/hr', desc: '2 vCPU · 4 GB at $0.008/hr — 2.2× cheaper than boat, 19× cheaper than Vercel. Stopped sandboxes cost exactly $0.' },
  { icon: GitFork, title: 'O(1) copy-on-write fork', desc: 'Fork any sandbox in single-digit milliseconds via metadata/ hardlink COW. Fan out 100 parallel test branches instantly.' },
  { icon: Clock, title: 'Auto-hibernate optimizer', desc: 'Idle watchdog hibernates quiet sandboxes to snapshot-only pricing (~92% cheaper). Wake on first SSH/exec in ~150ms.' },
  { icon: Boxes, title: '24-lane orchestrator', desc: 'Priority worker pool executes thousands of lifecycle ops concurrently with backpressure, rate limiting and retries.' },
  { icon: Sparkles, title: 'Built-in agent runtime', desc: 'ReAct + DAG strategies with PARALLEL tool calls — batch independent tools and run them concurrently, with live step streaming.' },
  { icon: Camera, title: 'Snapshots & templates', desc: 'Snapshot any state, fork from it, promote it to a template. Ubuntu, Node, Python, Desktop+Chrome, Docker, CUDA.' },
  { icon: Terminal, title: 'SSH · web terminal · API', desc: 'Real shell in every sandbox. Full REST API + API keys + WebSocket event stream for programmatic fleets.' },
  { icon: Gauge, title: 'Live fleet metrics', desc: 'Per-second CPU/RAM/disk/network sampling pushed over WebSocket. No agents to install, no exporters to babysit.' },
  { icon: ShieldCheck, title: 'Budget guardrails', desc: 'Hard budgets with alert thresholds, waste detection, and audit logs. Never get a surprise cloud bill again.' },
]

export function Landing() {
  const [fleet, setFleet] = useState<{ running: number; total: number; perSecond: number } | null>(null)
  const [vcpu, setVcpu] = useState(2)
  const [mem, setMem] = useState(4)
  const [hours, setHours] = useState(120)
  const [sandboxes, setSandboxes] = useState(3)

  useEffect(() => {
    void api('/bootstrap').catch(() => {})
    let alive = true
    const load = () =>
      api<{ metrics: { byStatus: Record<string, number> } }>('/metrics')
        .then((m) => {
          if (!alive) return
          setFleet({
            running: m.metrics.byStatus.running ?? 0,
            total: Object.values(m.metrics.byStatus).reduce((a, b) => a + b, 0),
            perSecond: 0,
          })
        })
        .catch(() => {})
    load()
    const iv = setInterval(load, 5000)
    return () => {
      alive = false
      clearInterval(iv)
    }
  }, [])

  // interactive cost projection
  const calc = useMemo(() => {
    const flint = (vcpu * 0.00000111 + mem * 0.00000022) * 3600 * hours * sandboxes
    const rows = COMPETITORS.map((c) => ({
      name: c.name,
      cost: c.name === 'Flint' ? flint : c.hourly * hours * sandboxes,
    }))
    const boat = rows.find((r) => r.name === 'boat.dev')!.cost
    return { flint, rows, boat, savings: boat - flint }
  }, [vcpu, mem, hours, sandboxes])
  const maxCost = Math.max(...calc.rows.map((r) => r.cost), 0.01)

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* nav */}
      <header className="sticky top-0 z-40 border-b border-zinc-800/80 bg-zinc-950/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-amber-400 to-orange-600">
              <span className="text-[13px] font-black text-zinc-950">F</span>
            </div>
            <span className="font-mono text-sm font-bold tracking-tight">flint</span>
            <Badge variant="outline" className="ml-1 border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-400">v1.0</Badge>
          </div>
          <nav className="hidden items-center gap-6 text-sm text-zinc-400 md:flex">
            <a href="#features" className="hover:text-zinc-100">Features</a>
            <a href="#pricing" className="hover:text-zinc-100">Pricing</a>
            <a href="#compare" className="hover:text-zinc-100">vs boat.dev</a>
            <a href="#api" className="hover:text-zinc-100">API</a>
          </nav>
          <Button size="sm" onClick={() => navigate('dashboard')} className="bg-amber-500 font-semibold text-zinc-950 hover:bg-amber-400">
            Open Console <ArrowRight className="ml-1 h-3.5 w-3.5" />
          </Button>
        </div>
      </header>

      {/* hero */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_0%,rgba(245,158,11,0.13),transparent_70%)]" />
        <div className="pointer-events-none absolute inset-0 opacity-[0.15] [background-image:linear-gradient(rgba(255,255,255,.06)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.06)_1px,transparent_1px)] [background-size:44px_44px]" />
        <div className="relative mx-auto max-w-6xl px-4 pb-20 pt-20 text-center md:pt-28">
          <Badge variant="outline" className="mb-5 border-amber-500/40 bg-amber-500/10 text-amber-400">
            <Sparkles className="mr-1 h-3 w-3" /> The open-source answer to boat.dev
          </Badge>
          <h1 className="mx-auto max-w-3xl text-4xl font-black leading-[1.08] tracking-tight md:text-6xl">
            Sandboxes for agents.
            <br />
            <span className="bg-gradient-to-r from-amber-300 via-orange-400 to-amber-500 bg-clip-text text-transparent">Every feature. Half the cost.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-zinc-400 md:text-lg">
            Persistent Ubuntu sandboxes with SSH, Docker, desktop, snapshots and O(1) fork — plus a built-in
            agent runtime with <span className="text-zinc-200">parallel tool execution</span>. Billed per second
            at <span className="font-mono text-amber-400">$0.008/hr</span> per 2vCPU·4GB. Free when stopped.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button size="lg" onClick={() => navigate('sandboxes')} className="bg-amber-500 font-semibold text-zinc-950 hover:bg-amber-400">
              Launch a sandbox <ArrowRight className="ml-1 h-4 w-4" />
            </Button>
            <Button size="lg" variant="outline" onClick={() => navigate('agents')} className="border-zinc-700 bg-zinc-900 text-zinc-200 hover:border-amber-500/50 hover:text-amber-300">
              <Sparkles className="mr-1 h-4 w-4 text-amber-500" /> Run an agent task
            </Button>
          </div>

          {/* live stat strip */}
          <div className="mx-auto mt-14 grid max-w-3xl grid-cols-2 gap-3 md:grid-cols-4">
            {[
              { k: 'Fleet', v: fleet ? `${fleet.running}/${fleet.total} live` : '…' },
              { k: 'Orchestrator', v: '24 lanes' },
              { k: 'Fork time', v: '<10ms' },
              { k: 'Metering', v: 'per-second' },
            ].map((s) => (
              <div key={s.k} className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-3">
                <div className="text-[10px] uppercase tracking-widest text-zinc-500">{s.k}</div>
                <div className="mt-1 font-mono text-sm font-semibold text-amber-400">{s.v}</div>
              </div>
            ))}
          </div>

          {/* terminal teaser */}
          <div className="mx-auto mt-10 max-w-3xl overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/70 text-left font-mono text-[12.5px] leading-relaxed shadow-2xl shadow-black/40">
            <div className="flex items-center gap-1.5 border-b border-zinc-800 px-4 py-2.5">
              <span className="h-2.5 w-2.5 rounded-full bg-red-500/70" />
              <span className="h-2.5 w-2.5 rounded-full bg-amber-500/70" />
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" />
              <span className="ml-2 text-[11px] text-zinc-500">flint console — flint-build-runner</span>
            </div>
            <div className="space-y-1 px-4 py-4 text-zinc-300">
              <div><span className="text-amber-400">$</span> flint create --template node-22 --vcpu 4 --mem 8</div>
              <div className="text-zinc-500">→ sandbox sbx_k3f9 running · boot 480ms · fork-ready</div>
              <div><span className="text-amber-400">$</span> flint agent run "audit deps, fix CVEs, open PR" --parallel-tools 6</div>
              <div className="text-zinc-500">→ planning DAG · 5 steps · wave 1/3 (2 tools in parallel)</div>
              <div className="text-zinc-500">→ ⚡ 3 tools in 1.2s wall vs 4.8s sequential (4.0× speedup)</div>
              <div className="text-emerald-400">→ done · $0.012 LLM · $0.0002 compute · PR #42 opened</div>
              <div className="flex items-center gap-1"><span className="text-amber-400">$</span><span className="inline-block h-4 w-1.5 animate-pulse bg-amber-400/80" /></div>
            </div>
          </div>
        </div>
      </section>

      {/* features */}
      <section id="features" className="mx-auto max-w-6xl px-4 py-20">
        <h2 className="text-center text-3xl font-bold tracking-tight">Everything boat has. Then the parts they don&apos;t.</h2>
        <p className="mx-auto mt-3 max-w-xl text-center text-zinc-500">
          Full sandbox platform parity — plus a native agent runtime, cost optimizer and unlimited concurrency.
        </p>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <Card key={f.title} className="group border-zinc-800 bg-zinc-900/50 transition-colors hover:border-amber-500/40">
              <CardContent className="p-5">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/10">
                  <f.icon className="h-4.5 w-4.5 text-amber-500" />
                </div>
                <div className="mt-4 font-semibold text-zinc-100">{f.title}</div>
                <p className="mt-1.5 text-sm leading-relaxed text-zinc-500">{f.desc}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* pricing + interactive calculator */}
      <section id="pricing" className="border-y border-zinc-800/60 bg-zinc-900/30">
        <div className="mx-auto max-w-6xl px-4 py-20">
          <h2 className="text-center text-3xl font-bold tracking-tight">Do the math they can&apos;t beat</h2>
          <p className="mx-auto mt-3 max-w-xl text-center text-zinc-500">Drag the sliders — this is what the same fleet costs elsewhere.</p>

          <div className="mt-10 grid gap-8 lg:grid-cols-[1fr_1.2fr]">
            <Card className="border-zinc-800 bg-zinc-900/70">
              <CardContent className="space-y-6 p-6">
                <div>
                  <div className="flex justify-between text-sm"><span className="text-zinc-400">vCPUs per sandbox</span><span className="font-mono text-amber-400">{vcpu}</span></div>
                  <Slider value={[vcpu]} min={1} max={16} step={1} onValueChange={([v]) => setVcpu(v)} className="mt-2" />
                </div>
                <div>
                  <div className="flex justify-between text-sm"><span className="text-zinc-400">RAM (GB)</span><span className="font-mono text-amber-400">{mem}</span></div>
                  <Slider value={[mem]} min={1} max={64} step={1} onValueChange={([v]) => setMem(v)} className="mt-2" />
                </div>
                <div>
                  <div className="flex justify-between text-sm"><span className="text-zinc-400">Hours / month</span><span className="font-mono text-amber-400">{hours}</span></div>
                  <Slider value={[hours]} min={10} max={720} step={10} onValueChange={([v]) => setHours(v)} className="mt-2" />
                </div>
                <div>
                  <div className="flex justify-between text-sm"><span className="text-zinc-400">Sandboxes</span><span className="font-mono text-amber-400">{sandboxes}</span></div>
                  <Slider value={[sandboxes]} min={1} max={50} step={1} onValueChange={([v]) => setSandboxes(v)} className="mt-2" />
                </div>
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4">
                  <div className="text-xs uppercase tracking-wider text-emerald-400">You keep, every month</div>
                  <div className="mt-1 font-mono text-2xl font-bold text-emerald-400">+{fmtUsd(calc.savings)}</div>
                  <div className="mt-1 text-xs text-emerald-500/80">vs boat.dev for the identical fleet</div>
                </div>
              </CardContent>
            </Card>

            <div className="space-y-3">
              {calc.rows.map((r) => {
                const isFlint = r.name === 'Flint'
                return (
                  <div key={r.name} className={cn('rounded-xl border p-4', isFlint ? 'border-amber-500/50 bg-amber-500/[0.07]' : 'border-zinc-800 bg-zinc-900/50')}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className={cn('font-mono text-sm font-semibold', isFlint ? 'text-amber-400' : 'text-zinc-300')}>{r.name}</span>
                        {isFlint && <Badge className="bg-amber-500 text-[10px] font-bold text-zinc-950">cheapest</Badge>}
                      </div>
                      <span className={cn('font-mono text-lg font-bold', isFlint ? 'text-amber-400' : 'text-zinc-400')}>{fmtUsd(r.cost)}</span>
                    </div>
                    <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-zinc-800">
                      <div
                        className={cn('h-full rounded-full', isFlint ? 'bg-gradient-to-r from-amber-400 to-orange-500' : 'bg-zinc-600')}
                        style={{ width: `${Math.max(2, (r.cost / maxCost) * 100)}%` }}
                      />
                    </div>
                    <div className="mt-1.5 text-[11px] text-zinc-600">
                      {isFlint ? `${vcpu} vCPU · ${mem} GB · ${hours}h × ${sandboxes} sandboxes · per-second metering` : `${(r.cost / calc.flint).toFixed(1)}× Flint for the same workload`}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </section>

      {/* comparison table */}
      <section id="compare" className="mx-auto max-w-6xl px-4 py-20">
        <h2 className="text-center text-3xl font-bold tracking-tight">Feature-for-feature</h2>
        <div className="mt-10 overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full min-w-[760px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/80">
                <th className="p-3 text-left font-medium text-zinc-500">Capability</th>
                {COMPETITORS.map((c) => (
                  <th key={c.name} className={cn('p-3 text-center font-semibold', c.highlight ? 'bg-amber-500/10 text-amber-400' : 'text-zinc-300')}>
                    {c.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="font-mono text-[13px]">
              {[
                { label: '2vCPU·4GB hourly', get: (c: (typeof COMPETITORS)[number]) => `$${c.hourly.toFixed(3)}/hr` },
                { label: 'Per-second billing', get: (c: (typeof COMPETITORS)[number]) => c.perSecond },
                { label: 'Free when stopped', get: (c: (typeof COMPETITORS)[number]) => c.freeStopped },
                { label: 'Auto-hibernate optimizer', get: (c: (typeof COMPETITORS)[number]) => c.autoHibernate },
                { label: 'Fork speed', get: (c: (typeof COMPETITORS)[number]) => c.fork },
                { label: 'Concurrent sandboxes', get: (c: (typeof COMPETITORS)[number]) => c.cap },
                { label: 'SSH + Docker', get: (c: (typeof COMPETITORS)[number]) => c.sshDocker },
                { label: 'Desktop + Chrome', get: (c: (typeof COMPETITORS)[number]) => c.desktop },
                { label: '/dev/kvm passthrough', get: (c: (typeof COMPETITORS)[number]) => c.kvm },
                { label: 'Native agent runtime', get: (c: (typeof COMPETITORS)[number]) => c.agents },
                { label: 'Self-hostable / open source', get: (c: (typeof COMPETITORS)[number]) => c.name !== 'Vercel Sandbox' },
              ].map((row, i) => (
                <tr key={row.label} className={cn('border-b border-zinc-800/60', i % 2 === 1 && 'bg-zinc-900/30')}>
                  <td className="p-3 font-sans text-zinc-400">{row.label}</td>
                  {COMPETITORS.map((c) => {
                    const v = row.get(c)
                    return (
                      <td key={c.name} className={cn('p-3 text-center', c.highlight && 'bg-amber-500/[0.06]')}>
                        {typeof v === 'boolean' ? (
                          v ? <Check className="mx-auto h-4 w-4 text-emerald-400" /> : <X className="mx-auto h-4 w-4 text-zinc-700" />
                        ) : (
                          <span className={c.highlight ? 'text-amber-300' : 'text-zinc-400'}>{v}</span>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-center text-xs text-zinc-600">Competitor pricing from public pages, Oct 2026. We re-check monthly.</p>
      </section>

      {/* API teaser */}
      <section id="api" className="border-y border-zinc-800/60 bg-zinc-900/30">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-20 lg:grid-cols-2 lg:items-center">
          <div>
            <h2 className="text-3xl font-bold tracking-tight">One API. Whole fleet.</h2>
            <p className="mt-4 leading-relaxed text-zinc-400">
              Everything the console does is a REST call. Create sandboxes, fork states, run agent tasks with
              parallel tools, stream terminal output over WebSocket — all with one API key and per-second
              metering behind it.
            </p>
            <ul className="mt-6 space-y-2 text-sm text-zinc-400">
              {['POST /sandboxes — provision & boot', 'POST /sandboxes/:id/action — start · stop · fork · snapshot', 'POST /agent-tasks — ReAct or DAG strategy', 'WS / — live events + terminal stream'].map((l) => (
                <li key={l} className="flex items-center gap-2"><ChevronRight className="h-3.5 w-3.5 text-amber-500" />{l}</li>
              ))}
            </ul>
            <Button onClick={() => navigate('api')} variant="outline" className="mt-6 border-zinc-700 bg-zinc-900 hover:border-amber-500/50 hover:text-amber-300">
              <Copy className="mr-1.5 h-4 w-4 text-amber-500" /> Get an API key
            </Button>
          </div>
          <pre className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950 p-5 font-mono text-[12.5px] leading-relaxed text-zinc-300 shadow-2xl shadow-black/40">
{`curl -X POST https://api.flint.dev/v1/sandboxes \\
  -H "Authorization: Bearer flint_live_…" \\
  -d '{
    "template": "browser-agent",
    "vcpu": 2, "memoryGb": 4,
    "hibernateAfterMin": 10
  }'

# → 201 { "id": "sbx_k3f9", "status": "running",
#        "bootMs": 412, "ssh": "ssh …" }

curl -X POST …/agent-tasks \\
  -d '{
    "sandboxId": "sbx_k3f9",
    "prompt": "scrape top 50 HN posts",
    "strategy": "dag",
    "toolConcurrency": 6
  }'
# → steps stream over WebSocket, tools run in PARALLEL`}
          </pre>
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-6xl px-4 py-24 text-center">
        <h2 className="text-3xl font-bold tracking-tight md:text-4xl">Ship agents. Skip the markup.</h2>
        <p className="mx-auto mt-4 max-w-lg text-zinc-500">Spin up your first sandbox in under a second. No credit card, no sales call.</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Button size="lg" onClick={() => navigate('dashboard')} className="bg-amber-500 font-semibold text-zinc-950 hover:bg-amber-400">
            Open the console <ArrowRight className="ml-1 h-4 w-4" />
          </Button>
          <Button size="lg" variant="outline" onClick={() => navigate('cost')} className="border-zinc-700 bg-zinc-900 hover:border-amber-500/50 hover:text-amber-300">
            See cost center
          </Button>
        </div>
      </section>

      <footer className="border-t border-zinc-800/60 py-8">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 text-xs text-zinc-600">
          <span>flint · open-source sandbox & agent orchestration · Apache-2.0</span>
          <span className="font-mono">$0.008/hr · per-second billing · free when stopped</span>
        </div>
      </footer>
    </div>
  )
}
