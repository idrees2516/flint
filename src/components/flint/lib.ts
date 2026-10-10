'use client'

// ─────────────────────────────────────────────────────────────
// Flint · Frontend runtime — typed API client, socket fan-in,
// polling hooks, shared view state.
// ─────────────────────────────────────────────────────────────
import { useEffect, useRef, useState, useCallback } from 'react'
import { io, type Socket } from 'socket.io-client'

// ── types ────────────────────────────────────────────────────
export type View = 'landing' | 'dashboard' | 'sandboxes' | 'terminal' | 'agents' | 'studio' | 'templates' | 'cost' | 'api'

export interface Template {
  id: string
  slug: string
  name: string
  description: string
  category: string
  icon: string
  baseImage: string
  tags: string
  bootSeconds: number
  sizeMb: number
  launches: number
  isOfficial: boolean
}

export interface Sandbox {
  id: string
  name: string
  status: string
  driver: string
  region: string
  vcpu: number
  memoryGb: number
  diskGb: number
  sshPort?: number | null
  parentId?: string | null
  hibernateAfterMin: number
  lastActiveAt: string
  startedAt?: string | null
  stoppedAt?: string | null
  createdAt: string
  template?: { name: string; slug: string; icon: string } | null
  _count?: { snapshots: number; tasks: number }
}

export interface AgentTask {
  id: string
  name: string
  prompt: string
  status: string
  strategy: string
  model: string
  maxSteps: number
  toolConcurrency: number
  plan: string
  result: string
  error?: string | null
  tokensIn: number
  tokensOut: number
  costUsd: number
  createdAt: string
  startedAt?: string | null
  finishedAt?: string | null
  sandbox?: { id: string; name: string; status: string } | null
  _count?: { steps: number }
}

export interface TaskStep {
  id: string
  idx: number
  kind: string
  tool?: string | null
  status: string
  parallel: boolean
  input: string
  output: string
  durationMs?: number | null
  createdAt: string
}

export interface CostSummary {
  totalCost: number
  totalSeconds: number
  budget: { id?: string; monthlyLimitUsd: number; alertThreshold: number; spentUsd: number }
  spend: { id: string; name: string; seconds: number; cost: number }[]
  waste: { id: string; name: string; idleMin: number; hibernateAfterMin: number; recommendation: string; savingsPerDay: number }[]
  savings: { boat: number; vercel: number; modal: number }
  monthlyProjection: { hoursPriced: number; flint: number }
}

export interface FlintEventPayload {
  type: string
  level?: string
  source?: string
  message: string
  refId?: string
  data?: Record<string, unknown>
  ts?: number
}

// ── api client ───────────────────────────────────────────────
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/flint${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`)
  return data as T
}

// ── socket singleton ─────────────────────────────────────────
const g = globalThis as unknown as { __flintSocket?: Socket }
export function flintSocket(): Socket {
  if (!g.__flintSocket) {
    // Direct access on :3000 (local/dev) bypasses the Caddy gateway,
    // so connect straight to the realtime service; via the gateway,
    // use the XTransformPort convention on the same origin.
    const direct =
      typeof window !== 'undefined' && window.location.port === '3000' ? `http://${window.location.hostname}:3003` : undefined
    g.__flintSocket = io(direct ?? '/?XTransformPort=3003', {
      transports: ['websocket', 'polling'],
      reconnectionDelay: 800,
    })
  }
  return g.__flintSocket
}

export function useFlintEvents(onEvent: (e: FlintEventPayload) => void): void {
  const ref = useRef(onEvent)
  useEffect(() => {
    ref.current = onEvent
  })
  useEffect(() => {
    const s = flintSocket()
    const h = (e: FlintEventPayload) => ref.current(e)
    s.on('flint:event', h)
    return () => {
      s.off('flint:event', h)
    }
  }, [])
}

// ── polling hook — refetch interval + manual invalidate ──────
// Accepts either an API path string ('/sandboxes') or a fetcher fn.
export function usePoll<T>(pathOrFetcher: string | (() => Promise<T>), intervalMs = 4000, deps: unknown[] = []): {
  data: T | null
  error: string | null
  loading: boolean
  refresh: () => void
} {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  const fetcher = typeof pathOrFetcher === 'string' ? () => api<T>(pathOrFetcher) : pathOrFetcher
  const fetcherRef = useRef(fetcher)
  useEffect(() => {
    fetcherRef.current = fetcher
  })

  useEffect(() => {
    let alive = true
    const run = async () => {
      try {
        const d = await fetcherRef.current()
        if (alive) {
          setData(d)
          setError(null)
        }
      } catch (e) {
        if (alive) setError(String((e as Error).message ?? e))
      } finally {
        if (alive) setLoading(false)
      }
    }
    void run()
    const iv = setInterval(run, intervalMs)
    return () => {
      alive = false
      clearInterval(iv)
    }
  }, [intervalMs, tick, ...deps])

  const refresh = useCallback(() => setTick((t) => t + 1), [])
  return { data, error, loading, refresh }
}

// ── misc ─────────────────────────────────────────────────────
export const fmtUsd = (v: number): string => {
  if (v === 0) return '$0.00'
  if (v < 0.01) return `$${v.toFixed(5)}`
  if (v < 1) return `$${v.toFixed(4)}`
  return `$${v.toFixed(2)}`
}

export const fmtDur = (sec: number): string => {
  if (sec < 60) return `${Math.round(sec)}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
}

export const fmtAgo = (iso?: string | null): string => {
  if (!iso) return '—'
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return `${Math.round(s)}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export const mb = (v: number): string => (v >= 1024 ? `${(v / 1024).toFixed(1)} GB` : `${v} MB`)

// ── view state (lightweight store — no context cascade) ─────
const listeners = new Set<() => void>()
let viewState: { view: View; sandboxId?: string | null; taskId?: string | null } = { view: 'landing' }

export function navigate(view: View, opts?: { sandboxId?: string; taskId?: string }): void {
  viewState = { view, ...opts }
  listeners.forEach((l) => l())
}

export function useView(): { view: View; sandboxId?: string | null; taskId?: string | null; navigate: typeof navigate } {
  const [, force] = useState(0)
  useEffect(() => {
    const l = () => force((n) => n + 1)
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])
  return { ...viewState, navigate }
}

export const STATUS_COLOR: Record<string, string> = {
  running: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30',
  provisioning: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
  stopped: 'text-zinc-400 bg-zinc-500/10 border-zinc-600/30',
  hibernated: 'text-sky-300 bg-sky-500/10 border-sky-500/30',
  error: 'text-red-400 bg-red-500/10 border-red-500/30',
  queued: 'text-zinc-400 bg-zinc-500/10 border-zinc-600/30',
  planning: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
  done: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30',
  failed: 'text-red-400 bg-red-500/10 border-red-500/30',
  cancelled: 'text-zinc-400 bg-zinc-500/10 border-zinc-600/30',
}
