'use client'

// ─────────────────────────────────────────────────────────────
// Flint · Studio Dock — kernel REPL, swarm, goals, heartbeats,
// harness, MCP catalog and the factory dock.
// ─────────────────────────────────────────────────────────────
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { api, usePoll, fmtUsd, fmtAgo } from './lib'
import { cn } from '@/lib/utils'
import type { ModelInfo } from './studio'
import {
  Terminal, Bot, Target, Timer, BookOpen, Plug, Factory as FactoryIcon,
  Play, Trash2, RefreshCw, Plus, Send, Zap, ChevronDown, Cable, Copy, Check,
} from 'lucide-react'

type DockTab = 'kernel' | 'swarm' | 'goals' | 'heartbeats' | 'harness' | 'mcp' | 'factory' | 'acp'

const TABS: { id: DockTab; label: string; icon: typeof Terminal }[] = [
  { id: 'kernel', label: 'Kernel', icon: Terminal },
  { id: 'swarm', label: 'Swarm', icon: Bot },
  { id: 'goals', label: 'Goals', icon: Target },
  { id: 'heartbeats', label: 'Beats', icon: Timer },
  { id: 'harness', label: 'Harness', icon: BookOpen },
  { id: 'mcp', label: 'MCP', icon: Plug },
  { id: 'factory', label: 'Factory', icon: FactoryIcon },
  { id: 'acp', label: 'ACP', icon: Cable },
]

export function StudioDock({
  sessionId,
  models,
  refreshSessions,
}: {
  sessionId: string | null
  models: ModelInfo[]
  refreshSessions: () => void
}) {
  const [tab, setTab] = useState<DockTab>('kernel')
  return (
    <div className="flex h-[calc(100vh-170px)] min-h-[480px] flex-col rounded-xl border border-zinc-800 bg-zinc-950/60">
      <div className="flex flex-wrap gap-0.5 border-b border-zinc-800 p-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'flex items-center gap-1 rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors',
              tab === t.id ? 'bg-amber-500/10 text-amber-300' : 'text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-300'
            )}
          >
            <t.icon className="h-3.5 w-3.5" />
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {tab === 'acp' ? (
          <AcpTab />
        ) : !sessionId ? (
          <p className="mt-8 text-center text-xs text-zinc-600">select a session</p>
        ) : tab === 'kernel' ? (
          <KernelTab sessionId={sessionId} />
        ) : tab === 'swarm' ? (
          <SwarmTab sessionId={sessionId} models={models} refreshSessions={refreshSessions} />
        ) : tab === 'goals' ? (
          <GoalsTab sessionId={sessionId} />
        ) : tab === 'heartbeats' ? (
          <HeartbeatsTab sessionId={sessionId} />
        ) : tab === 'harness' ? (
          <HarnessTab />
        ) : tab === 'mcp' ? (
          <McpTab />
        ) : (
          <FactoryTab sessionId={sessionId} />
        )}
      </div>
    </div>
  )
}

// ── kernel REPL ─────────────────────────────────────────────
interface KernelEval {
  ok: boolean
  stdout: string
  stderr: string
  durationMs: number
}

function KernelTab({ sessionId }: { sessionId: string }) {
  const [code, setCode] = useState('')
  const [history, setHistory] = useState<Array<{ code: string; res: KernelEval }>>([])
  const [evaling, setEvaling] = useState(false)
  const kernel = usePoll<{ vars: Record<string, string>; stats: Record<string, unknown> }>(
    `/sessions/${sessionId}/kernel`,
    5000,
    [sessionId]
  )

  async function run() {
    const src = code.trim()
    if (!src || evaling) return
    setEvaling(true)
    try {
      const d = await api<{ result: KernelEval }>(`/sessions/${sessionId}/kernel`, {
        method: 'POST',
        body: JSON.stringify({ code: src }),
      })
      setHistory((h) => [...h.slice(-6), { code: src, res: d.result }])
      setCode('')
      kernel.refresh()
    } catch (e) {
      setHistory((h) => [...h.slice(-6), { code: src, res: { ok: false, stdout: '', stderr: String(e), durationMs: 0 } }])
    } finally {
      setEvaling(false)
    }
  }

  const vars = Object.entries(kernel.data?.vars ?? {}).filter(([k]) => !['bash', 'read', 'write', 'edit', 'ls', 'host', 'websearch', 'flint_done'].includes(k))

  return (
    <div className="space-y-3">
      <div className="text-[11px] text-zinc-500">
        Direct eval in the session&apos;s persistent kernel (same namespace the agent uses).
      </div>
      <textarea
        value={code}
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void run()
          }
        }}
        rows={4}
        placeholder="x = 41  ·  x + 1  ·  host('list_agents')"
        className="w-full resize-none rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5 py-2 font-mono text-[12px] text-amber-100 placeholder:text-zinc-600 focus:border-amber-500/40 focus:outline-none"
      />
      <Button size="sm" className="h-7 w-full gap-1 bg-amber-500 text-[11px] font-semibold text-zinc-950 hover:bg-amber-400" disabled={evaling || !code.trim()} onClick={() => void run()}>
        <Play className="h-3 w-3" /> {evaling ? 'running…' : 'eval (⌘↵)'}
      </Button>
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">live variables ({vars.length})</span>
          <button className="text-zinc-600 hover:text-zinc-300" onClick={kernel.refresh}>
            <RefreshCw className="h-3 w-3" />
          </button>
        </div>
        <div className="space-y-0.5">
          {vars.slice(0, 24).map(([k, v]) => (
            <div key={k} className="truncate rounded border border-zinc-800/60 bg-zinc-900/40 px-2 py-1 font-mono text-[10.5px]">
              <span className="text-sky-300">{k}</span>
              <span className="text-zinc-600"> = </span>
              <span className="text-zinc-400">{v}</span>
            </div>
          ))}
          {vars.length === 0 && <p className="text-[11px] text-zinc-600">empty namespace</p>}
        </div>
      </div>
      {history.length > 0 && (
        <div className="space-y-1.5 border-t border-zinc-800 pt-2">
          {history.map((h, i) => (
            <div key={i} className="rounded border border-zinc-800/60 bg-zinc-900/40 p-2">
              <pre className="whitespace-pre-wrap font-mono text-[10.5px] text-amber-200/80">&gt;&gt;&gt; {h.code}</pre>
              <pre className={cn('mt-1 whitespace-pre-wrap font-mono text-[10.5px]', h.res.ok ? 'text-zinc-400' : 'text-red-400')}>
                {(h.res.stdout || h.res.stderr || '(no output)').slice(0, 600)}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── swarm (subagents + A2A) ─────────────────────────────────
interface SessionLite {
  id: string
  name: string
  status: string
  depth: number
  model: string
  lastMessage: string
}

function SwarmTab({ sessionId, models, refreshSessions }: { sessionId: string; models: ModelInfo[]; refreshSessions: () => void }) {
  const [spawnName, setSpawnName] = useState('')
  const [spawnPrompt, setSpawnPrompt] = useState('')
  const [spawnModel, setSpawnModel] = useState('glm-4.7-flash')
  const [msgTo, setMsgTo] = useState('*')
  const [msgBody, setMsgBody] = useState('')
  const [note, setNote] = useState('')

  const swarm = usePoll<{ sessions: SessionLite[] }>('/sessions', 4000)
  const family = (swarm.data?.sessions ?? []).filter((s) => s.id !== sessionId)
  const me = (swarm.data?.sessions ?? []).find((s) => s.id === sessionId)

  async function spawn() {
    if (!spawnPrompt.trim()) return
    const code = `host("spawn", ${JSON.stringify(spawnName || 'subagent')}, ${JSON.stringify(spawnPrompt)}, ${JSON.stringify(spawnModel)})`
    await api(`/sessions/${sessionId}/kernel`, { method: 'POST', body: JSON.stringify({ code }) })
    setSpawnPrompt('')
    setNote(`spawned "${spawnName || 'subagent'}" (${spawnModel}) — it runs in the background`)
    refreshSessions()
    swarm.refresh()
  }

  async function sendMsg() {
    if (!msgBody.trim()) return
    const code = `host("send_message", ${JSON.stringify(msgTo)}, ${JSON.stringify(msgBody)})`
    const d = await api<{ result: KernelEvalish }>(`/sessions/${sessionId}/kernel`, {
      method: 'POST',
      body: JSON.stringify({ code }),
    }).catch(() => null)
    setMsgBody('')
    setNote(d ? 'message sent' : 'send failed')
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5">
        <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-zinc-500">spawn subagent</div>
        <div className="flex gap-1.5">
          <input value={spawnName} onChange={(e) => setSpawnName(e.target.value)} placeholder="name (optional)" className="h-7 w-24 rounded border border-zinc-800 bg-zinc-900 px-2 font-mono text-[11px] text-zinc-300 placeholder:text-zinc-600 focus:outline-none" />
          <select value={spawnModel} onChange={(e) => setSpawnModel(e.target.value)} className="h-7 rounded border border-zinc-800 bg-zinc-900 px-1 font-mono text-[10px] text-zinc-300 focus:outline-none">
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </div>
        <textarea value={spawnPrompt} onChange={(e) => setSpawnPrompt(e.target.value)} rows={2} placeholder="task prompt — gets its own kernel + model" className="mt-1.5 w-full resize-none rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 font-mono text-[11px] text-zinc-300 placeholder:text-zinc-600 focus:outline-none" />
        <Button size="sm" className="mt-1.5 h-7 w-full gap-1 bg-sky-500 text-[11px] font-semibold text-zinc-950 hover:bg-sky-400" disabled={!spawnPrompt.trim()} onClick={() => void spawn()}>
          <Plus className="h-3 w-3" /> spawn
        </Button>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5">
        <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-zinc-500">send A2A message</div>
        <select value={msgTo} onChange={(e) => setMsgTo(e.target.value)} className="h-7 w-full rounded border border-zinc-800 bg-zinc-900 px-2 font-mono text-[11px] text-zinc-300 focus:outline-none">
          <option value="*">* (broadcast — siblings + children)</option>
          {family.map((s) => (
            <option key={s.id} value={s.id}>{s.name} (d{s.depth} · {s.status})</option>
          ))}
        </select>
        <textarea value={msgBody} onChange={(e) => setMsgBody(e.target.value)} rows={2} placeholder="message body" className="mt-1.5 w-full resize-none rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 font-mono text-[11px] text-zinc-300 placeholder:text-zinc-600 focus:outline-none" />
        <Button size="sm" className="mt-1.5 h-7 w-full gap-1 bg-violet-500 text-[11px] font-semibold text-zinc-950 hover:bg-violet-400" disabled={!msgBody.trim()} onClick={() => void sendMsg()}>
          <Send className="h-3 w-3" /> send
        </Button>
      </div>

      {note && <p className="text-[11px] text-emerald-400">{note}</p>}

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">agent roster ({family.length + 1})</span>
          <button className="text-zinc-600 hover:text-zinc-300" onClick={swarm.refresh}>
            <RefreshCw className="h-3 w-3" />
          </button>
        </div>
        <div className="space-y-1">
          {me && <RosterRow s={me} me />}
          {family.map((s) => (
            <RosterRow key={s.id} s={s} />
          ))}
        </div>
      </div>
    </div>
  )
}

interface KernelEvalish {
  ok: boolean
  stdout: string
  stderr: string
}

function RosterRow({ s, me }: { s: SessionLite; me?: boolean }) {
  return (
    <div className={cn('rounded border px-2 py-1.5', me ? 'border-amber-500/30 bg-amber-500/5' : 'border-zinc-800/60 bg-zinc-900/40')}>
      <div className="flex items-center gap-1.5">
        <span className={cn('h-1 w-1 rounded-full', s.status === 'running' ? 'animate-pulse bg-emerald-400' : s.status === 'error' ? 'bg-red-400' : 'bg-zinc-500')} />
        <span className="truncate font-mono text-[11px] text-zinc-300">{s.name}</span>
        <span className="ml-auto font-mono text-[9px] text-zinc-600">d{s.depth} · {s.model}</span>
      </div>
      {s.lastMessage && <p className="mt-0.5 truncate text-[10px] text-zinc-600">{s.lastMessage}</p>}
    </div>
  )
}

// ── goals + autonomous ──────────────────────────────────────
interface GoalView {
  id: string
  objective: string
  status: string
  tokenBudget: number
  tokensUsed: number
  turnsUsed: number
  session: { name: string }
  createdAt: string
}

function GoalsTab({ sessionId }: { sessionId: string }) {
  const [objective, setObjective] = useState('')
  const [budget, setBudget] = useState('40000')
  const [autonomous, setAutonomous] = useState(false)
  const [gates, setGates] = useState('')
  const goals = usePoll<{ goals: GoalView[] }>('/goals', 5000)

  async function createGoal() {
    if (!objective.trim()) return
    await api('/goals', {
      method: 'POST',
      body: JSON.stringify({ sessionId, objective, tokenBudget: Number(budget) || 40000 }),
    })
    setObjective('')
    goals.refresh()
  }

  async function runAutonomous() {
    if (!objective.trim()) return
    const gateList = gates.split('\n').map((g) => g.trim()).filter(Boolean)
    await api(`/sessions/${sessionId}/autonomous`, {
      method: 'POST',
      body: JSON.stringify({ objective, gates: gateList, maxTurns: 12 }),
    })
    setNote2('autonomous run started — watch the transcript')
  }

  const [note2, setNote2] = useState('')

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5">
        <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-zinc-500">new goal</div>
        <textarea value={objective} onChange={(e) => setObjective(e.target.value)} rows={2} placeholder="persistent objective — harness keeps re-prompting until goal_complete()" className="w-full resize-none rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 font-mono text-[11px] text-zinc-300 placeholder:text-zinc-600 focus:outline-none" />
        <div className="mt-1.5 flex items-center gap-2">
          <input value={budget} onChange={(e) => setBudget(e.target.value)} className="h-7 w-24 rounded border border-zinc-800 bg-zinc-900 px-2 font-mono text-[11px] text-zinc-300 focus:outline-none" />
          <span className="text-[10px] text-zinc-600">token budget</span>
          <Button size="sm" className="ml-auto h-7 gap-1 bg-emerald-500 px-2 text-[11px] font-semibold text-zinc-950 hover:bg-emerald-400" disabled={!objective.trim()} onClick={() => void createGoal()}>
            <Target className="h-3 w-3" /> set goal
          </Button>
        </div>
      </div>

      <div className="rounded-lg border border-orange-500/25 bg-orange-500/5 p-2.5">
        <label className="mb-2 flex cursor-pointer items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-orange-300">
          <input type="checkbox" checked={autonomous} onChange={(e) => setAutonomous(e.target.checked)} className="accent-orange-400" />
          autonomous mode (with gates)
        </label>
        <textarea value={gates} onChange={(e) => setGates(e.target.value)} rows={2} placeholder={'shell gates, one per line, e.g.\nls report.md\npython -c "assert 1+1==2"'} className="w-full resize-none rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 font-mono text-[11px] text-zinc-300 placeholder:text-zinc-600 focus:outline-none" />
        <Button size="sm" className="mt-1.5 h-7 w-full gap-1 bg-orange-500 text-[11px] font-semibold text-zinc-950 hover:bg-orange-400" disabled={!objective.trim()} onClick={() => void runAutonomous()}>
          <Zap className="h-3 w-3" /> run autonomous
        </Button>
        {note2 && <p className="mt-1.5 text-[11px] text-orange-300">{note2}</p>}
      </div>

      <div>
        <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-zinc-500">goals</div>
        <div className="space-y-1">
          {(goals.data?.goals ?? []).map((g) => (
            <div key={g.id} className="rounded border border-zinc-800/60 bg-zinc-900/40 px-2 py-1.5">
              <div className="flex items-center gap-1.5">
                <span className={cn('h-1 w-1 rounded-full', g.status === 'active' ? 'animate-pulse bg-emerald-400' : g.status === 'complete' ? 'bg-emerald-600' : 'bg-zinc-600')} />
                <span className="truncate font-mono text-[10.5px] text-zinc-300">{g.objective}</span>
                <span className="ml-auto font-mono text-[9px] text-zinc-600">{g.status}</span>
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-[9.5px] text-zinc-600">
                <span>{g.session.name}</span>
                <span>· {g.tokensUsed.toLocaleString()}/{g.tokenBudget.toLocaleString()} tok</span>
                <span>· {g.turnsUsed} turns</span>
              </div>
            </div>
          ))}
          {(goals.data?.goals ?? []).length === 0 && <p className="text-[11px] text-zinc-600">no goals yet</p>}
        </div>
      </div>
    </div>
  )
}

// ── heartbeats ──────────────────────────────────────────────
interface HeartbeatView {
  id: string
  name: string
  cron: string
  prompt: string
  mode: string
  enabled: boolean
  fireCount: number
  human: string
  session: { name: string }
}

function HeartbeatsTab({ sessionId }: { sessionId: string }) {
  const [name, setName] = useState('')
  const [cron, setCron] = useState('*/5 * * * *')
  const [prompt, setPrompt] = useState('')
  const [mode, setMode] = useState('follow-up')
  const hbs = usePoll<{ heartbeats: HeartbeatView[] }>('/heartbeats', 6000)

  async function create() {
    if (!name.trim() || !prompt.trim()) return
    await api('/heartbeats', { method: 'POST', body: JSON.stringify({ sessionId, name, cron, prompt, mode }) })
    setName('')
    setPrompt('')
    hbs.refresh()
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5">
        <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-zinc-500">new heartbeat (cron)</div>
        <div className="flex gap-1.5">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name" className="h-7 flex-1 rounded border border-zinc-800 bg-zinc-900 px-2 font-mono text-[11px] text-zinc-300 placeholder:text-zinc-600 focus:outline-none" />
          <input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="*/5 * * * *" className="h-7 w-32 rounded border border-zinc-800 bg-zinc-900 px-2 font-mono text-[11px] text-zinc-300 focus:outline-none" />
        </div>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2} placeholder="prompt delivered on each fire" className="mt-1.5 w-full resize-none rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 font-mono text-[11px] text-zinc-300 placeholder:text-zinc-600 focus:outline-none" />
        <div className="mt-1.5 flex items-center gap-2">
          <select value={mode} onChange={(e) => setMode(e.target.value)} className="h-7 rounded border border-zinc-800 bg-zinc-900 px-2 font-mono text-[10px] text-zinc-300 focus:outline-none">
            <option value="follow-up">follow-up</option>
            <option value="steer">steer</option>
          </select>
          <Button size="sm" className="ml-auto h-7 gap-1 bg-amber-500 px-2 text-[11px] font-semibold text-zinc-950 hover:bg-amber-400" disabled={!name.trim() || !prompt.trim()} onClick={() => void create()}>
            <Timer className="h-3 w-3" /> schedule
          </Button>
        </div>
      </div>
      <div className="space-y-1">
        {(hbs.data?.heartbeats ?? []).map((h) => (
          <div key={h.id} className="rounded border border-zinc-800/60 bg-zinc-900/40 px-2 py-1.5">
            <div className="flex items-center gap-1.5">
              <button
                onClick={async () => {
                  await api('/heartbeats', { method: 'PATCH', body: JSON.stringify({ id: h.id, enabled: !h.enabled }) })
                  hbs.refresh()
                }}
                className={cn('h-2 w-2 rounded-full', h.enabled ? 'animate-pulse bg-emerald-400' : 'bg-zinc-600')}
                title={h.enabled ? 'disable' : 'enable'}
              />
              <span className="truncate font-mono text-[11px] text-zinc-300">{h.name}</span>
              <span className="ml-auto font-mono text-[9px] text-amber-500/70">{h.cron}</span>
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-[9.5px] text-zinc-600">
              <span>{h.session.name}</span>
              <span>· {h.human}</span>
              <span>· fired {h.fireCount}×</span>
              <button className="ml-auto text-zinc-600 hover:text-red-400" onClick={async () => { await api(`/heartbeats?id=${h.id}`, { method: 'DELETE' }); hbs.refresh() }}>
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          </div>
        ))}
        {(hbs.data?.heartbeats ?? []).length === 0 && <p className="text-[11px] text-zinc-600">no heartbeats scheduled</p>}
      </div>
    </div>
  )
}

// ── harness (continual self-improvement) ────────────────────
interface HarnessItemView {
  id: string
  kind: string
  name: string
  content: string
  scope: string
  version: number
  useCount: number
  updatedAt: string
}

interface RefinementView {
  id: string
  reason: string
  status: string
  before: string
  after: string
  createdAt: string
  item: { kind: string; name: string }
}

const KINDS = [
  { id: 'memory', label: 'Memories' },
  { id: 'prompt_note', label: 'Prompt notes' },
  { id: 'skill', label: 'Skills' },
  { id: 'subagent_spec', label: 'Subagent specs' },
]

function HarnessTab() {
  const [kind, setKind] = useState('memory')
  const [name, setName] = useState('')
  const [content, setContent] = useState('')
  const harness = usePoll<{ items: HarnessItemView[]; refinements: RefinementView[] }>('/harness', 8000)
  const items = (harness.data?.items ?? []).filter((i) => i.kind === kind)
  const refinements = harness.data?.refinements ?? []

  async function save() {
    if (!name.trim() || !content.trim()) return
    await api('/harness', { method: 'POST', body: JSON.stringify({ kind, name, content }) })
    setName('')
    setContent('')
    harness.refresh()
  }

  async function refine() {
    const evidence = items.map((i) => `${i.kind}/${i.name}: ${i.content}`).join('\n\n')
    await api('/harness/refine', { method: 'POST', body: JSON.stringify({ evidence: evidence.slice(0, 6000), maxEdits: 2 }) })
    harness.refresh()
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1">
        {KINDS.map((k) => (
          <button
            key={k.id}
            onClick={() => setKind(k.id)}
            className={cn('rounded-md px-2 py-1 text-[10.5px] font-medium', kind === k.id ? 'bg-amber-500/10 text-amber-300' : 'text-zinc-500 hover:text-zinc-300')}
          >
            {k.label}
          </button>
        ))}
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5">
        <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-zinc-500">{kind} · new / update</div>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name" className="h-7 w-full rounded border border-zinc-800 bg-zinc-900 px-2 font-mono text-[11px] text-zinc-300 placeholder:text-zinc-600 focus:outline-none" />
        <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={3} placeholder="content — injected into the system prompt / skills inventory" className="mt-1.5 w-full resize-none rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 font-mono text-[11px] text-zinc-300 placeholder:text-zinc-600 focus:outline-none" />
        <div className="mt-1.5 flex gap-1.5">
          <Button size="sm" className="h-7 flex-1 bg-amber-500 text-[11px] font-semibold text-zinc-950 hover:bg-amber-400" disabled={!name.trim() || !content.trim()} onClick={() => void save()}>
            save
          </Button>
          <Button size="sm" variant="outline" className="h-7 flex-1 gap-1 border-zinc-700 text-[11px] text-zinc-300" onClick={() => void refine()}>
            <ChevronDown className="h-3 w-3" /> refine (auto)
          </Button>
        </div>
      </div>

      <div className="space-y-1">
        {items.map((i) => (
          <details key={i.id} className="group rounded border border-zinc-800/60 bg-zinc-900/40 px-2 py-1.5">
            <summary className="flex cursor-pointer list-none items-center gap-1.5">
              <span className="truncate font-mono text-[11px] text-zinc-300">{i.name}</span>
              <span className="ml-auto font-mono text-[9px] text-zinc-600">v{i.version} · {i.useCount}×</span>
              <button className="text-zinc-700 opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-400" onClick={async (e) => { e.preventDefault(); await api(`/harness?id=${i.id}`, { method: 'DELETE' }); harness.refresh() }}>
                <Trash2 className="h-3 w-3" />
              </button>
            </summary>
            <p className="mt-1 whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-zinc-500">{i.content}</p>
          </details>
        ))}
        {items.length === 0 && <p className="text-[11px] text-zinc-600">no {kind}s yet</p>}
      </div>

      {refinements.length > 0 && (
        <div>
          <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-zinc-500">refinement history</div>
          <div className="space-y-1">
            {refinements.slice(0, 6).map((r) => (
              <div key={r.id} className="rounded border border-zinc-800/60 bg-zinc-900/40 px-2 py-1.5">
                <div className="flex items-center gap-1.5">
                  <span className={cn('rounded px-1 font-mono text-[8.5px] uppercase', r.status === 'applied' ? 'bg-emerald-500/10 text-emerald-400' : r.status === 'rolled-back' ? 'bg-zinc-700/30 text-zinc-400' : 'bg-amber-500/10 text-amber-400')}>{r.status}</span>
                  <span className="truncate font-mono text-[10px] text-zinc-400">{r.item.kind}/{r.item.name}</span>
                  <span className="ml-auto flex gap-1">
                    {r.status === 'planned' && (
                      <button className="text-[9px] text-emerald-400 hover:underline" onClick={async () => { await api('/harness/refine', { method: 'POST', body: JSON.stringify({ refinementId: r.id, action: 'apply' }) }); harness.refresh() }}>apply</button>
                    )}
                    {r.status === 'applied' && (
                      <button className="text-[9px] text-amber-400 hover:underline" onClick={async () => { await api('/harness/refine', { method: 'POST', body: JSON.stringify({ refinementId: r.id, action: 'rollback' }) }); harness.refresh() }}>rollback</button>
                    )}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-[9.5px] text-zinc-600">{r.reason}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── MCP ─────────────────────────────────────────────────────
interface McpServerView {
  id: string
  name: string
  transport: string
  url: string
  enabled: boolean
  toolCount: number
}

interface McpCatalogEntry {
  name: string
  label: string
  category: string
  url: string
  command: string
  desc: string
}

function McpTab() {
  const mcp = usePoll<{ servers: McpServerView[]; catalog: McpCatalogEntry[] }>('/mcp', 10000)
  const [tools, setTools] = useState<{ server: string; tools: string[] } | null>(null)

  async function addFromCatalog(entry: McpCatalogEntry) {
    await api('/mcp', {
      method: 'POST',
      body: JSON.stringify({ name: entry.name, transport: entry.url ? 'http' : 'stdio', url: entry.url, command: entry.command || undefined }),
    })
    mcp.refresh()
  }

  async function listToolsFor(server: string) {
    const d = await api<{ tools: Array<{ name: string; description?: string }> }>(`/mcp/${server}/tools`)
    setTools({ server, tools: d.tools.map((t) => `${t.name}${t.description ? ` — ${t.description.slice(0, 80)}` : ''}`) })
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-zinc-500">configured servers</div>
        <div className="space-y-1">
          {(mcp.data?.servers ?? []).map((s) => (
            <div key={s.id} className="rounded border border-zinc-800/60 bg-zinc-900/40 px-2 py-1.5">
              <div className="flex items-center gap-1.5">
                <span className={cn('h-1.5 w-1.5 rounded-full', s.enabled ? 'bg-emerald-400' : 'bg-zinc-600')} />
                <span className="font-mono text-[11px] text-zinc-300">{s.name}</span>
                <span className="font-mono text-[9px] text-zinc-600">{s.transport}</span>
                <div className="ml-auto flex items-center gap-1.5">
                  <button className="text-[9px] text-sky-400 hover:underline" onClick={() => void listToolsFor(s.name)}>tools</button>
                  <button className="text-[9px] text-zinc-500 hover:underline" onClick={async () => { await api(`/mcp/${s.name}/tools`); mcp.refresh() }}>
                    sync
                  </button>
                  <button className="text-zinc-700 hover:text-red-400" onClick={async () => { await api(`/mcp?id=${s.id}`, { method: 'DELETE' }); mcp.refresh() }}>
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>
              <div className="mt-0.5 font-mono text-[9px] text-zinc-600">{s.url || 'stdio'} · {s.toolCount} tools</div>
            </div>
          ))}
        </div>
      </div>

      {tools && (
        <div className="rounded-lg border border-sky-500/25 bg-sky-500/5 p-2">
          <div className="mb-1 font-mono text-[10px] text-sky-300">tools on {tools.server}</div>
          <div className="space-y-0.5">
            {tools.tools.map((t, i) => (
              <p key={i} className="truncate font-mono text-[10px] text-zinc-400">{t}</p>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-zinc-500">service catalog</div>
        <div className="space-y-1">
          {(mcp.data?.catalog ?? []).map((c) => (
            <div key={c.name} className="flex items-center gap-2 rounded border border-zinc-800/60 bg-zinc-900/40 px-2 py-1.5">
              <Plug className="h-3 w-3 shrink-0 text-zinc-600" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[10.5px] text-zinc-300">{c.label} <span className="text-zinc-600">· {c.category}</span></div>
                <p className="truncate text-[9.5px] text-zinc-600">{c.desc}</p>
              </div>
              <button className="shrink-0 text-[9px] text-amber-400 hover:underline" onClick={() => void addFromCatalog(c)}>connect</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── factory ─────────────────────────────────────────────────
interface MachineView {
  id: string
  slug: string
  name: string
  description: string
  spec: { nodes?: Array<{ id: string; title: string; kind: string; foreach?: string[]; next: string[] }> }
  _count?: { runs: number }
}

interface RunView {
  id: string
  status: string
  createdAt: string
  nodeStates: string
  machine: { name: string; slug: string }
}

function FactoryTab({ sessionId }: { sessionId: string }) {
  const factory = usePoll<{ machines: MachineView[]; runs: RunView[] }>('/factory', 5000)
  const [input, setInput] = useState('{"task": "write a haiku about sandboxes in haiku.txt"}')
  const [running, setRunning] = useState(false)

  async function runMachine(slug: string) {
    setRunning(true)
    try {
      let parsed: Record<string, unknown> = {}
      try {
        parsed = JSON.parse(input)
      } catch {
        parsed = { task: input }
      }
      await api(`/factory/${slug}/run`, { method: 'POST', body: JSON.stringify({ input: parsed, sessionId }) })
      factory.refresh()
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5">
        <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-zinc-500">machine input (JSON)</div>
        <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={2} className="w-full resize-none rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 font-mono text-[11px] text-zinc-300 focus:outline-none" />
      </div>

      <div className="space-y-1.5">
        {(factory.data?.machines ?? []).map((m) => (
          <div key={m.id} className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 px-2.5 py-2">
            <div className="flex items-center gap-1.5">
              <FactoryIcon className="h-3.5 w-3.5 text-amber-400/70" />
              <span className="font-mono text-[11.5px] font-semibold text-zinc-200">{m.name}</span>
              <Button size="sm" className="ml-auto h-6 gap-1 bg-amber-500 px-2 text-[10px] font-semibold text-zinc-950 hover:bg-amber-400" disabled={running} onClick={() => void runMachine(m.slug)}>
                <Play className="h-2.5 w-2.5" /> run
              </Button>
            </div>
            <p className="mt-0.5 text-[10px] text-zinc-500">{m.description}</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {(m.spec.nodes ?? []).map((n) => (
                <span key={n.id} className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 font-mono text-[9px] text-zinc-400">
                  {n.id}
                  {n.kind === 'join' ? ' ⋈' : n.foreach ? ` ×${n.foreach.length}` : ''}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div>
        <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-zinc-500">runs</div>
        <div className="space-y-1">
          {(factory.data?.runs ?? []).slice(0, 10).map((r) => (
            <div key={r.id} className="rounded border border-zinc-800/60 bg-zinc-900/40 px-2 py-1.5">
              <div className="flex items-center gap-1.5">
                <span className={cn('h-1 w-1 rounded-full', r.status === 'running' ? 'animate-pulse bg-amber-400' : r.status === 'done' ? 'bg-emerald-400' : r.status === 'failed' ? 'bg-red-400' : 'bg-zinc-600')} />
                <span className="truncate font-mono text-[10.5px] text-zinc-300">{r.machine.name}</span>
                <span className="ml-auto font-mono text-[9px] text-zinc-600">{r.status} · {fmtAgo(r.createdAt)}</span>
              </div>
            </div>
          ))}
          {(factory.data?.runs ?? []).length === 0 && <p className="text-[11px] text-zinc-600">no runs yet</p>}
        </div>
      </div>
    </div>
  )
}

// ── ACP (Agent Client Protocol) ─────────────────────────────
interface AcpStatus {
  protocolVersion: number
  metaNamespace: string
  adapter: { command: string; transport: string }
  methods: string[]
  notifications: string[]
  connections: Array<{
    id: string
    createdAt: number
    lastSeenAt: number
    client?: { name?: string; version?: string }
    sessions: Array<{
      sessionId: string
      title: string
      model: string
      thinkingLevel: string
      cwd?: string
      mcpServers: number
      promptTurns: number
    }>
  }>
}

function AcpTab() {
  const status = usePoll<AcpStatus>('/acp/status', 5000)
  const [copied, setCopied] = useState<string | null>(null)

  const d = status.data
  const conns = d?.connections ?? []

  const zedConfig = JSON.stringify(
    {
      flint: {
        name: 'Flint',
        command: 'node',
        args: ['<flint-repo>/scripts/flint-acp.mjs'],
        env: { FLINT_URL: 'http://127.0.0.1:3000' },
      },
    },
    null,
    2
  )

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
      setTimeout(() => setCopied(null), 1400)
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div className="space-y-3">
      <div className="text-[11px] leading-relaxed text-zinc-500">
        Editor bridge (Zed · Neovim): Flint serves the Agent Client Protocol over a stdio adapter —
        JSON-RPC 2.0, ndjson framing, session/update streaming with namespaced <span className="font-mono text-zinc-400">ai.flint.agent</span> meta.
      </div>

      {/* adapter card */}
      <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-2.5">
        <div className="mb-1.5 flex items-center gap-1.5">
          <Cable className="h-3.5 w-3.5 text-amber-400" />
          <span className="font-mono text-[11px] font-semibold text-zinc-200">flint-acp adapter</span>
          <span className="ml-auto rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[9px] text-emerald-300">
            protocol v{d?.protocolVersion ?? 1}
          </span>
        </div>
        <div className="flex items-center gap-1.5 rounded border border-zinc-800 bg-zinc-900/70 px-2 py-1.5">
          <code className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-amber-100/90">
            {d?.adapter.command ?? 'node scripts/flint-acp.mjs'}
          </code>
          <button
            className="shrink-0 text-zinc-500 hover:text-zinc-200"
            onClick={() => void copy(d?.adapter.command ?? 'node scripts/flint-acp.mjs', 'cmd')}
            title="copy command"
          >
            {copied === 'cmd' ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
          </button>
        </div>
        <div className="mt-1.5 grid grid-cols-2 gap-1 text-[9.5px] text-zinc-500">
          <div>transport: <span className="text-zinc-400">stdio · ndjson</span></div>
          <div>meta: <span className="text-zinc-400">{d?.metaNamespace ?? 'ai.flint.agent'}</span></div>
        </div>
      </div>

      {/* served surface */}
      <div>
        <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-zinc-500">served methods ({d?.methods.length ?? 0})</div>
        <div className="flex flex-wrap gap-1">
          {(d?.methods ?? []).map((m) => (
            <span key={m} className="rounded border border-zinc-800 bg-zinc-900/60 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
              {m}
            </span>
          ))}
        </div>
      </div>

      {/* live connections */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
            live connections ({conns.length})
          </span>
          <button className="text-zinc-600 hover:text-zinc-300" onClick={status.refresh}>
            <RefreshCw className="h-3 w-3" />
          </button>
        </div>
        <div className="space-y-1.5">
          {conns.map((c) => (
            <div key={c.id} className="rounded border border-zinc-800/60 bg-zinc-900/40 p-2">
              <div className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                <span className="truncate font-mono text-[10.5px] text-zinc-300">{c.id}</span>
                {c.client?.name && (
                  <span className="ml-auto rounded border border-zinc-800 px-1 font-mono text-[9px] text-zinc-500">{c.client.name}</span>
                )}
              </div>
              {c.sessions.map((s) => (
                <div key={s.sessionId} className="mt-1 truncate pl-3 font-mono text-[9.5px] text-zinc-500">
                  ↳ {s.title} · {s.model} · {s.promptTurns} turn{s.promptTurns === 1 ? '' : 's'}
                </div>
              ))}
              {c.sessions.length === 0 && <div className="mt-1 pl-3 text-[9.5px] text-zinc-600">no sessions yet</div>}
            </div>
          ))}
          {conns.length === 0 && (
            <p className="text-[11px] text-zinc-600">no editor connected — start one with the adapter command above</p>
          )}
        </div>
      </div>

      {/* Zed setup */}
      <div>
        <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-zinc-500">Zed · agents.json</div>
        <div className="relative">
          <pre className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950/80 p-2.5 font-mono text-[10px] leading-relaxed text-zinc-400">{zedConfig}</pre>
          <button
            className="absolute right-1.5 top-1.5 text-zinc-500 hover:text-zinc-200"
            onClick={() => void copy(zedConfig, 'zed')}
            title="copy config"
          >
            {copied === 'zed' ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
          </button>
        </div>
        <p className="mt-1 text-[9.5px] leading-relaxed text-zinc-600">
          Drop into <span className="font-mono">~/.config/zed/agents.json</span>, restart Zed, then open the agent panel and pick
          Flint. Neovim: point an ACP plugin at the same command.
        </p>
      </div>
    </div>
  )
}
