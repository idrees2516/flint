'use client'

import { Badge } from '@/components/ui/badge'
import { STATUS_COLOR } from './lib'
import { cn } from '@/lib/utils'
import type { LucideIcon } from 'lucide-react'
import { Box, Hexagon, BarChart3, Monitor, Globe, Container, Zap, Code, Terminal } from 'lucide-react'

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-mono font-medium capitalize',
        STATUS_COLOR[status] ?? 'text-zinc-400 bg-zinc-500/10 border-zinc-600/30'
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', status === 'running' || status === 'done' ? 'animate-pulse bg-current' : 'bg-current')} />
      {status}
    </span>
  )
}

export function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: LucideIcon
  label: string
  value: string
  sub?: string
  accent?: string
}) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wider text-zinc-500">{label}</span>
        <Icon className={cn('h-4 w-4', accent ?? 'text-amber-500')} />
      </div>
      <div className="mt-2 font-mono text-2xl font-semibold text-zinc-100">{value}</div>
      {sub ? <div className="mt-1 text-xs text-zinc-500">{sub}</div> : null}
    </div>
  )
}

export function SectionTitle({ title, sub, right }: { title: string; sub?: string; right?: React.ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold text-zinc-100">{title}</h2>
        {sub ? <p className="mt-0.5 text-sm text-zinc-500">{sub}</p> : null}
      </div>
      {right}
    </div>
  )
}

export const TEMPLATE_ICONS: Record<string, LucideIcon> = {
  terminal: Terminal,
  hexagon: Hexagon,
  'bar-chart-3': BarChart3,
  monitor: Monitor,
  globe: Globe,
  container: Container,
  zap: Zap,
  code: Code,
  box: Box,
}

export function TemplateIcon({ icon, className }: { icon: string; className?: string }) {
  const Icon = TEMPLATE_ICONS[icon] ?? Box
  return <Icon className={className ?? 'h-5 w-5 text-amber-500'} />
}

export function Sparkline({ points, className }: { points: number[]; className?: string }) {
  if (points.length < 2) points = [...points, ...points, 0]
  const max = Math.max(...points, 1)
  const w = 120
  const h = 32
  const step = w / (points.length - 1)
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - (p / max) * (h - 4) - 2).toFixed(1)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={cn('h-8 w-32', className)} preserveAspectRatio="none">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d={`${d} L${w},${h} L0,${h} Z`} fill="currentColor" opacity="0.08" />
    </svg>
  )
}

export function Empty({ icon: Icon, title, sub, action }: { icon: LucideIcon; title: string; sub?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30 p-12 text-center">
      <Icon className="h-10 w-10 text-zinc-700" />
      <div className="mt-3 font-medium text-zinc-300">{title}</div>
      {sub ? <div className="mt-1 max-w-sm text-sm text-zinc-600">{sub}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}
