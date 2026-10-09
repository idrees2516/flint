'use client'

import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { api, useView, useFlintEvents, flintSocket, type View } from './lib'
import { Landing } from './landing'
import { Dashboard } from './dashboard'
import { Sandboxes } from './sandboxes'
import { TerminalView } from './terminal-view'
import { Agents } from './agents'
import { TemplatesView } from './templates-view'
import { CostView } from './cost-view'
import { ApiView } from './api-view'
import { LayoutDashboard, Server, TerminalSquare, Sparkles, Boxes, DollarSign, KeyRound, Home, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useState } from 'react'

const NAV: { view: View; label: string; icon: typeof Home }[] = [
  { view: 'landing', label: 'Home', icon: Home },
  { view: 'dashboard', label: 'Overview', icon: LayoutDashboard },
  { view: 'sandboxes', label: 'Fleet', icon: Server },
  { view: 'terminal', label: 'Shell', icon: TerminalSquare },
  { view: 'agents', label: 'Agents', icon: Sparkles },
  { view: 'templates', label: 'Templates', icon: Boxes },
  { view: 'cost', label: 'Cost', icon: DollarSign },
  { view: 'api', label: 'API', icon: KeyRound },
]

export function FlintApp() {
  const { view, sandboxId, taskId, navigate } = useView()
  const [connected, setConnected] = useState(false)
  const [eventCount, setEventCount] = useState(0)

  // boot the control plane (idempotent)
  useEffect(() => {
    void api('/bootstrap').catch(() => {})
  }, [])

  // socket health
  useEffect(() => {
    const s = flintSocket()
    const onC = () => setConnected(true)
    const onD = () => setConnected(false)
    s.on('connect', onC)
    s.on('disconnect', onD)
    // sync initial state via the socket's own event, avoiding render-phase setState
    if (s.connected) onC()
    return () => {
      s.off('connect', onC)
      s.off('disconnect', onD)
    }
  }, [])

  useFlintEvents(() => setEventCount((c) => c + 1))

  return (
    <div className={cn('flex min-h-screen flex-col', view === 'landing' ? 'bg-zinc-950' : 'bg-[#0b0b0d]')}>
      {/* top bar */}
      <header className="sticky top-0 z-50 border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto flex h-12 max-w-[1400px] items-center gap-3 px-4">
          <button className="flex items-center gap-2" onClick={() => navigate('landing')}>
            <div className="flex h-6 w-6 items-center justify-center rounded bg-gradient-to-br from-amber-400 to-orange-600">
              <span className="text-[11px] font-black text-zinc-950">F</span>
            </div>
            <span className="font-mono text-sm font-bold tracking-tight text-zinc-100">flint</span>
          </button>

          <nav className="mx-auto hidden items-center gap-0.5 md:flex">
            {NAV.map((n) => (
              <button
                key={n.view}
                onClick={() => navigate(n.view)}
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors',
                  view === n.view ? 'bg-amber-500/10 text-amber-300' : 'text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-300'
                )}
              >
                <n.icon className={cn('h-3.5 w-3.5', view === n.view && 'text-amber-400')} />
                {n.label}
              </button>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2 md:ml-0">
            <div className="hidden items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900/60 px-2.5 py-1 text-[11px] sm:flex">
              <span className={cn('h-1.5 w-1.5 rounded-full', connected ? 'animate-pulse bg-emerald-400' : 'bg-red-400')} />
              <span className={cn('font-mono', connected ? 'text-zinc-400' : 'text-red-400')}>{connected ? 'realtime' : 'offline'}</span>
              {eventCount > 0 && <span className="font-mono text-amber-500/80">{eventCount}</span>}
            </div>
            <Button size="sm" className="h-7 bg-amber-500 px-3 text-xs font-semibold text-zinc-950 hover:bg-amber-400" onClick={() => navigate('sandboxes')}>
              <Zap className="mr-1 h-3 w-3" /> New sandbox
            </Button>
          </div>
        </div>

        {/* mobile nav */}
        <nav className="flex items-center gap-0.5 overflow-x-auto px-3 pb-2 md:hidden [scrollbar-width:none]">
          {NAV.map((n) => (
            <button
              key={n.view}
              onClick={() => navigate(n.view)}
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors',
                view === n.view ? 'bg-amber-500/10 text-amber-300' : 'text-zinc-500'
              )}
            >
              <n.icon className="h-3.5 w-3.5" />
              {n.label}
            </button>
          ))}
        </nav>
      </header>

      {/* content */}
      <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6">
        {view === 'landing' && <Landing />}
        {view === 'dashboard' && <Dashboard />}
        {view === 'sandboxes' && <Sandboxes />}
        {view === 'terminal' && <TerminalView sandboxId={sandboxId} />}
        {view === 'agents' && <Agents sandboxId={sandboxId} key={sandboxId ?? 'agents'} />}
        {view === 'templates' && <TemplatesView />}
        {view === 'cost' && <CostView />}
        {view === 'api' && <ApiView />}
      </main>

      {/* footer — sticks to bottom on short pages */}
      <footer className="mt-auto border-t border-zinc-800/60 py-4">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-2 px-4 text-[11px] text-zinc-600">
          <span className="font-mono">flint v1.0 · sandbox & agent orchestration · Apache-2.0</span>
          <span className="font-mono">$0.008/hr · per-second · free when stopped {taskId ? '' : ''}</span>
        </div>
      </footer>
    </div>
  )
}
