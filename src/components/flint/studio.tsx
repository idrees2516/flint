'use client'

// ─────────────────────────────────────────────────────────────
// Flint · Agent Studio — the RLM session cockpit.
// Sessions, transcripts, kernel REPL, subagent forest, goals,
// heartbeats, harness, MCP and the factory dock.
// ─────────────────────────────────────────────────────────────
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { api, usePoll, useFlintEvents, fmtUsd, fmtAgo, STATUS_COLOR } from './lib'
import { StudioDock } from './studio-dock'
import { cn } from '@/lib/utils'
import {
  Plus, Send, GitFork, FoldVertical, BrainCircuit, ChevronRight, Terminal,
  Coins, Bot, Trash2, Play, Target,
} from 'lucide-react'

// ── types ───────────────────────────────────────────────────
export interface AgentSessionView {
  id: string
  name: string
  role: string
  depth: number
  parentId?: string | null
  status: string
  model: string
  thinkingLevel: string
  sandboxId?: string | null
  tokensIn: number
  tokensOut: number
  costUsd: number
  turnCount: number
  lastMessage: string
  compactCount: number
  lastActiveAt: string
  createdAt: string
  _count?: { messages: number; children: number; inbox: number }
}

export interface SessionMessageView {
  id: string
  idx: number
  role: string
  kind: string
  content: string
  meta: string
  tokensIn: number
  tokensOut: number
  costUsd: number
  createdAt: string
}

export interface ModelInfo {
  id: string
  provider: string
  name: string
  contextK: number
  inputs: string[]
  thinking: boolean
  inPer1k: number
  outPer1k: number
  tags: string[]
}

// ── main ────────────────────────────────────────────────────
export function Studio() {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [busy, setBusy] = useState(false)

  const sessions = usePoll<{ sessions: AgentSessionView[] }>('/sessions', 3500)
  const roots = (sessions.data?.sessions ?? []).filter((s) => s.role !== 'subagent')
  const children = (sessions.data?.sessions ?? []).filter((s) => s.role === 'subagent')

  useEffect(() => {
    void api<{ models: ModelInfo[] }>('/models').then((d) => setModels(d.models)).catch(() => null)
  }, [])

  // auto-select first session
  useEffect(() => {
    if (!sessionId && roots.length > 0) setSessionId(roots[0].id)
  }, [sessionId, roots])

  // live refresh on events
  useFlintEvents((e) => {
    if (e.type.startsWith('session:') || e.type.startsWith('factory:') || e.type.startsWith('goal:')) {
      sessions.refresh()
    }
  })

  const current = useMemo(
    () => sessions.data?.sessions.find((s) => s.id === sessionId) ?? null,
    [sessions.data, sessionId]
  )

  async function newSession() {
    const name = `session · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    const d = await api<{ session: AgentSessionView }>('/sessions', {
      method: 'POST',
      body: JSON.stringify({ name, model: 'glm-4.7' }),
    })
    sessions.refresh()
    setSessionId(d.session.id)
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_minmax(0,1fr)] xl:grid-cols-[260px_minmax(0,1fr)_340px]">
      {/* left rail — sessions */}
      <aside className="order-1 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-zinc-200">
            <BrainCircuit className="h-4 w-4 text-amber-400" /> Sessions
          </h2>
          <Button size="sm" className="h-7 bg-amber-500 px-2 text-xs font-semibold text-zinc-950 hover:bg-amber-400" onClick={() => void newSession()}>
            <Plus className="h-3 w-3" />
          </Button>
        </div>
        <SessionRail
          sessions={roots}
          children={children}
          activeId={sessionId}
          onSelect={setSessionId}
        />
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 text-[11px] leading-relaxed text-zinc-500">
          <div className="mb-1 font-mono font-semibold text-zinc-400">RLM runtime</div>
          Persistent Python kernel per session · programmatic tool calling · subagents with own kernels · A2A
          messaging · goals · heartbeats · factory machines · compaction.
        </div>
      </aside>

      {/* center — chat */}
      <section className="order-3 min-w-0 lg:order-2">
        {current ? (
          <ChatPane
            session={current}
            busy={busy}
            setBusy={setBusy}
            models={models}
            onForked={setSessionId}
            refresh={sessions.refresh}
          />
        ) : (
          <div className="flex h-64 flex-col items-center justify-center rounded-xl border border-dashed border-zinc-800 text-zinc-600">
            <BrainCircuit className="h-8 w-8 text-zinc-700" />
            <p className="mt-2 text-sm">Create a session to start the RLM engine</p>
          </div>
        )}
      </section>

      {/* right — dock */}
      <aside className="order-2 min-w-0 lg:order-3">
        <StudioDock sessionId={sessionId} models={models} refreshSessions={sessions.refresh} />
      </aside>
    </div>
  )
}

// ── session rail (roots + nested subagents) ─────────────────
function SessionRail({
  sessions,
  children,
  activeId,
  onSelect,
}: {
  sessions: AgentSessionView[]
  children: AgentSessionView[]
  activeId: string | null
  onSelect: (id: string) => void
}) {
  if (sessions.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-800 p-4 text-center text-xs text-zinc-600">
        No sessions yet
      </div>
    )
  }
  return (
    <div className="space-y-1 overflow-y-auto pr-1" style={{ maxHeight: '60vh' }}>
      {sessions.map((s) => (
        <div key={s.id}>
          <button
            onClick={() => onSelect(s.id)}
            className={cn(
              'w-full rounded-lg border px-2.5 py-2 text-left transition-colors',
              activeId === s.id
                ? 'border-amber-500/40 bg-amber-500/10'
                : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-700 hover:bg-zinc-900'
            )}
          >
            <div className="flex items-center gap-1.5">
              <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', statusDot(s.status))} />
              <span className="truncate font-mono text-xs text-zinc-200">{s.name}</span>
            </div>
            <div className="mt-1 flex items-center gap-2 text-[10px] text-zinc-500">
              <span className="font-mono">{s.model}</span>
              <span>·</span>
              <span>{fmtUsd(s.costUsd)}</span>
              <span>·</span>
              <span>{fmtAgo(s.lastActiveAt)}</span>
            </div>
          </button>
          {children
            .filter((c) => c.parentId === s.id)
            .slice(0, 8)
            .map((c) => (
              <button
                key={c.id}
                onClick={() => onSelect(c.id)}
                className={cn(
                  'ml-4 mt-1 flex w-[calc(100%-1rem)] items-center gap-1.5 rounded-md border px-2 py-1.5 text-left',
                  activeId === c.id ? 'border-sky-500/40 bg-sky-500/10' : 'border-zinc-800/60 bg-zinc-900/20 hover:bg-zinc-900/50'
                )}
              >
                <ChevronRight className="h-3 w-3 shrink-0 text-zinc-600" />
                <span className={cn('h-1 w-1 shrink-0 rounded-full', statusDot(c.status))} />
                <span className="truncate font-mono text-[11px] text-zinc-400">{c.name}</span>
                <span className="ml-auto font-mono text-[9px] text-zinc-600">d{c.depth}</span>
              </button>
            ))}
        </div>
      ))}
    </div>
  )
}

function statusDot(status: string): string {
  if (status === 'running') return 'bg-emerald-400 animate-pulse'
  if (status === 'done') return 'bg-emerald-500'
  if (status === 'error') return 'bg-red-400'
  if (status === 'idle') return 'bg-zinc-500'
  return 'bg-zinc-600'
}

// ── chat pane ───────────────────────────────────────────────
function ChatPane({
  session,
  busy,
  setBusy,
  models,
  onForked,
  refresh,
}: {
  session: AgentSessionView
  busy: boolean
  setBusy: (b: boolean) => void
  models: ModelInfo[]
  onForked: (id: string) => void
  refresh: () => void
}) {
  const [draft, setDraft] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const endRef = useRef<HTMLDivElement>(null)

  const detail = usePoll<{ session: { messages: SessionMessageView[]; goals: GoalView[] } }>(
    `/sessions/${session.id}`,
    busy ? 1500 : 4000,
    [session.id, busy]
  )

  useFlintEvents((e) => {
    if (e.refId === session.id && (e.type === 'session:turn-done' || e.type === 'session:error' || e.type === 'session:stdout')) {
      detail.refresh()
      if (e.type !== 'session:stdout') refresh()
    }
  })

  useEffect(() => {
    if (autoScroll) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [detail.data, autoScroll])

  const messages = detail.data?.session.messages ?? []
  const running = session.status === 'running'

  async function send() {
    const text = draft.trim()
    if (!text || running) return
    setDraft('')
    setBusy(true)
    try {
      await api(`/sessions/${session.id}/messages`, { method: 'POST', body: JSON.stringify({ text }) })
      detail.refresh()
    } catch (e) {
      console.error(e)
    } finally {
      setTimeout(() => setBusy(false), 1200)
    }
  }

  async function setModel(model: string) {
    await api(`/sessions/${session.id}`, { method: 'PATCH', body: JSON.stringify({ model }) })
    refresh()
  }

  async function fork() {
    const d = await api<{ session: AgentSessionView }>(`/sessions/${session.id}/fork`, { method: 'POST', body: JSON.stringify({}) })
    onForked(d.session.id)
    refresh()
  }

  async function compact() {
    await api(`/sessions/${session.id}/compact`, { method: 'POST', body: JSON.stringify({}) })
    detail.refresh()
  }

  return (
    <div className="flex h-[calc(100vh-170px)] min-h-[480px] flex-col rounded-xl border border-zinc-800 bg-zinc-950/60">
      {/* header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <span className={cn('h-2 w-2 rounded-full', statusDot(session.status))} />
        <span className="font-mono text-sm font-semibold text-zinc-100">{session.name}</span>
        <span className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">
          {session.role}
        </span>
        {session.compactCount > 0 && (
          <span className="rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 font-mono text-[10px] text-sky-300">
            compacted ×{session.compactCount}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <select
            value={session.model}
            onChange={(e) => void setModel(e.target.value)}
            className="h-7 rounded-md border border-zinc-800 bg-zinc-900 px-1.5 font-mono text-[11px] text-zinc-300 outline-none"
          >
            {models.length === 0 && <option>{session.model}</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <span className="hidden items-center gap-1 font-mono text-[10px] text-zinc-500 sm:flex">
            <Coins className="h-3 w-3" />
            {(session.tokensIn + session.tokensOut).toLocaleString()} tok · {fmtUsd(session.costUsd)}
          </span>
          <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-[11px] text-zinc-400" onClick={() => void compact()} title="Compact transcript">
            <FoldVertical className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-[11px] text-zinc-400" onClick={() => void fork()} title="Fork session">
            <GitFork className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* transcript */}
      <div className="flex-1 space-y-2.5 overflow-y-auto px-3 py-3">
        {messages.length === 0 && (
          <div className="mt-12 text-center text-sm text-zinc-600">
            <Terminal className="mx-auto h-6 w-6 text-zinc-700" />
            <p className="mt-2">Send a message — the agent answers with Python in its persistent kernel.</p>
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} msg={m} />
        ))}
        {running && (
          <div className="flex items-center gap-2 px-1 text-xs text-amber-400/80">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
            <span className="font-mono">thinking / executing kernel…</span>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* composer */}
      <div className="border-t border-zinc-800 p-2.5">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            rows={2}
            disabled={running}
            placeholder={running ? 'session busy — agent is working…' : 'Message the agent (Enter to send, Shift+Enter newline)'}
            className="min-h-[44px] flex-1 resize-none rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 font-mono text-[13px] text-zinc-200 placeholder:text-zinc-600 focus:border-amber-500/40 focus:outline-none disabled:opacity-50"
          />
          <Button
            size="sm"
            className="h-10 bg-amber-500 px-3 font-semibold text-zinc-950 hover:bg-amber-400"
            disabled={running || !draft.trim()}
            onClick={() => void send()}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
        <label className="mt-1.5 flex cursor-pointer items-center gap-1.5 text-[10px] text-zinc-600">
          <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} className="accent-amber-500" />
          auto-scroll
        </label>
      </div>
    </div>
  )
}

// ── message bubble by kind ──────────────────────────────────
export function MessageBubble({ msg }: { msg: SessionMessageView }) {
  if (msg.kind === 'summary') {
    return (
      <div className="rounded-lg border border-sky-500/25 bg-sky-500/5 px-3 py-2">
        <div className="mb-1 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-sky-300">
          <FoldVertical className="h-3 w-3" /> compaction summary
        </div>
        <pre className="whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-zinc-300">{msg.content}</pre>
      </div>
    )
  }
  if (msg.kind === 'code') {
    return (
      <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] px-3 py-2">
        <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-amber-400/80">agent · python</div>
        <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-amber-100/90">{msg.content}</pre>
      </div>
    )
  }
  if (msg.kind === 'stdout') {
    const meta = safeParse(msg.meta)
    const ok = meta.ok !== false
    return (
      <div className={cn('rounded-lg border px-3 py-2', ok ? 'border-zinc-800 bg-zinc-900/70' : 'border-red-500/30 bg-red-500/5')}>
        <div className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
          <Terminal className="h-3 w-3" />
          kernel {ok ? 'output' : 'raised'} {meta.durationMs ? `· ${meta.durationMs}ms` : ''}
        </div>
        <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-zinc-300">{msg.content}</pre>
      </div>
    )
  }
  if (msg.kind === 'a2a') {
    return (
      <div className="rounded-lg border border-violet-500/25 bg-violet-500/5 px-3 py-2">
        <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-violet-300">
          <Bot className="mr-1 inline h-3 w-3" /> agent message
        </div>
        <pre className="whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-zinc-300">{msg.content}</pre>
      </div>
    )
  }
  if (msg.kind === 'gate') {
    return (
      <div className="rounded-lg border border-orange-500/25 bg-orange-500/5 px-3 py-2">
        <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-orange-300">completion gate</div>
        <pre className="whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-zinc-300">{msg.content}</pre>
      </div>
    )
  }
  if (msg.kind === 'spawn') {
    return (
      <div className="rounded-lg border border-sky-500/25 bg-sky-500/5 px-3 py-2">
        <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-sky-300">
          <Play className="mr-1 inline h-3 w-3" /> subagent task
        </div>
        <pre className="whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-zinc-300">{msg.content}</pre>
      </div>
    )
  }
  if (msg.kind === 'goal' || msg.kind === 'heartbeat') {
    return (
      <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2">
        <div className="mb-1 flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-emerald-300">
          <Target className="h-3 w-3" /> {msg.kind} prompt
        </div>
        <pre className="whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-zinc-300">{msg.content}</pre>
      </div>
    )
  }
  // chat (user / assistant)
  const isUser = msg.role === 'user'
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-lg px-3 py-2',
          isUser ? 'bg-amber-500/15 text-amber-50' : 'border border-zinc-800 bg-zinc-900/60 text-zinc-200'
        )}
      >
        <div className={cn('mb-0.5 font-mono text-[10px] uppercase tracking-wider', isUser ? 'text-amber-300/70' : 'text-zinc-500')}>
          {isUser ? 'you' : 'agent'}
        </div>
        <div className="whitespace-pre-wrap text-[13px] leading-relaxed">{msg.content}</div>
      </div>
    </div>
  )
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}

export interface GoalView {
  id: string
  objective: string
  status: string
  tokenBudget: number
  tokensUsed: number
  turnsUsed: number
  result: string
  session: { id: string; name: string; model: string }
  createdAt: string
}
