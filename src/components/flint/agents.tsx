'use client'

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { toast } from 'sonner'
import {
  Sparkles, Plus, Brain, Wrench, CheckCircle2, XCircle, Zap, Loader2, ChevronLeft, X,
  MessageSquareText, Flag, Ban, Play,
} from 'lucide-react'
import { api, usePoll, useFlintEvents, fmtUsd, fmtAgo, navigate, type AgentTask, type TaskStep, type Sandbox } from './lib'
import { StatusBadge, SectionTitle, Empty } from './ui-bits'
import { cn } from '@/lib/utils'

const SAMPLE_PROMPTS = [
  { label: 'Workspace inventory', text: 'Inspect this sandbox: list files, check installed runtimes and versions, then write a SUMMARY.md with everything you found.' },
  { label: 'Parallel research', text: 'Search the web for the latest serverless sandbox providers and their pricing, then write a comparison table to competitors.md.' },
  { label: 'Build & verify', text: 'Write a small Express server to server.js, install nothing, verify it parses by checking the file, and document endpoints in API.md.' },
]

export function Agents({ sandboxId }: { sandboxId?: string | null }) {
  // keyed by sandboxId in the shell — remounts fresh, so initial state is safe
  const [creating, setCreating] = useState(Boolean(sandboxId))
  const [selected, setSelected] = useState<string | null>(null)
  const tasks = usePoll<{ tasks: AgentTask[] }>('/tasks', 3000)

  useFlintEvents((e) => {
    if (e.type.startsWith('task:')) tasks.refresh()
  })

  // derived selection — first task by default (no effect cascade)
  const taskList = tasks.data?.tasks ?? []
  const selectedId = selected ?? taskList[0]?.id ?? null
  const task = taskList.find((t) => t.id === selectedId) ?? null

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Agent hub"
        sub="Autonomous tasks on your fleet · ReAct + DAG strategies · parallel tool execution"
        right={
          <Button size="sm" className="bg-amber-500 font-semibold text-zinc-950 hover:bg-amber-400" onClick={() => setCreating(true)}>
            <Plus className="mr-1.5 h-4 w-4" /> New task
          </Button>
        }
      />

      {(tasks.data?.tasks ?? []).length === 0 && tasks.loading ? (
        <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-amber-500" /></div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[300px_1fr]">
          {/* task list */}
          <div className="space-y-2">
            {taskList.length === 0 && (
              <Empty
                icon={Sparkles}
                title="No agent tasks yet"
                sub="Dispatch an autonomous task to a sandbox — watch steps stream live with parallel tool speedups."
                action={<Button size="sm" className="bg-amber-500 font-semibold text-zinc-950 hover:bg-amber-400" onClick={() => setCreating(true)}><Plus className="mr-1.5 h-4 w-4" /> New task</Button>}
              />
            )}
            {taskList.map((t) => (
              <button
                key={t.id}
                onClick={() => setSelected(t.id)}
                className={cn(
                  'w-full rounded-xl border p-3.5 text-left transition-colors',
                  t.id === selectedId ? 'border-amber-500/60 bg-amber-500/[0.07]' : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-zinc-200">{t.name}</span>
                  <StatusBadge status={t.status} />
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500">
                  <Badge variant="outline" className="h-4 border-zinc-700 px-1 font-mono text-[10px]">{t.strategy}</Badge>
                  {t.sandbox && <span className="truncate font-mono">{t.sandbox.name}</span>}
                  <span>·</span>
                  <span>{t._count?.steps ?? 0} steps</span>
                </div>
                <div className="mt-1.5 flex items-center justify-between text-[11px] text-zinc-600">
                  <span>{fmtAgo(t.createdAt)}</span>
                  <span className="font-mono text-zinc-500">{fmtUsd(t.costUsd)}</span>
                </div>
              </button>
            ))}
          </div>

          {/* detail */}
          {task ? <TaskDetail task={task} onBack={() => setSelected(null)} /> : (
            <Card className="hidden border-dashed border-zinc-800 bg-zinc-900/30 lg:flex lg:items-center lg:justify-center">
              <div className="text-center text-sm text-zinc-600">Select a task to inspect its execution timeline</div>
            </Card>
          )}
        </div>
      )}

      <CreateTaskDialog open={creating} onOpenChange={setCreating} prefillSandbox={sandboxId} onCreated={(id) => setSelected(id)} />
    </div>
  )
}

// ── task detail with live step stream ────────────────────────
function TaskDetail({ task, onBack }: { task: AgentTask; onBack: () => void }) {
  const [tick, setTick] = useState(0)
  const detail = usePoll<{ task: AgentTask & { steps: TaskStep[] } }>(`/tasks/${task.id}`, task.status === 'running' || task.status === 'planning' || task.status === 'queued' ? 1500 : 10000)
  useFlintEvents((e) => {
    if (e.refId === task.id && e.type === 'task:step') setTick((t) => t + 1)
  })

  const t = detail.data?.task ?? task
  const steps = t.steps ?? []
  const isLive = t.status === 'running' || t.status === 'planning' || t.status === 'queued'
  const speedups = useMemo(() => {
    const groups = new Map<number, TaskStep[]>()
    for (const s of steps) {
      if (s.kind !== 'tool_call') continue
      const g = groups.get(s.idx) ?? []
      g.push(s)
      groups.set(s.idx, g)
    }
    return steps.filter((s) => s.kind === 'tool_call' && s.parallel).map((s) => s.durationMs ?? 0)
  }, [steps, tick])

  const parallelCount = steps.filter((s) => s.parallel).length
  const toolMs = steps.filter((s) => s.kind === 'tool_call').reduce((a, s) => a + (s.durationMs ?? 0), 0)
  const wallMs = t.startedAt && t.finishedAt ? new Date(t.finishedAt).getTime() - new Date(t.startedAt).getTime() : null

  return (
    <Card className="border-zinc-800 bg-zinc-900/50">
      <CardContent className="p-0">
        {/* header */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-2">
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-zinc-500 lg:hidden" onClick={onBack}><ChevronLeft className="h-4 w-4" /></Button>
            <span className="truncate text-sm font-semibold text-zinc-100">{t.name}</span>
            <StatusBadge status={t.status} />
          </div>
          {isLive && (
            <Button size="sm" variant="outline" className="h-7 border-zinc-700 text-xs text-red-400 hover:border-red-500/50" onClick={() => void api(`/tasks/${t.id}`, { method: 'POST' }).then(() => toast('Cancellation requested'))}>
              <Ban className="mr-1 h-3 w-3" /> Cancel
            </Button>
          )}
        </div>

        {/* meta */}
        <div className="grid grid-cols-2 gap-px border-b border-zinc-800 bg-zinc-800 sm:grid-cols-4">
          {[
            { k: 'Strategy', v: t.strategy === 'dag' ? 'DAG waves' : 'ReAct loop' },
            { k: 'Parallel tools', v: `${t.toolConcurrency} lanes` },
            { k: 'Tokens', v: `${(t.tokensIn + t.tokensOut).toLocaleString()}` },
            { k: 'Cost', v: fmtUsd(t.costUsd) },
          ].map((m) => (
            <div key={m.k} className="bg-zinc-900/80 px-5 py-3">
              <div className="text-[10px] uppercase tracking-wider text-zinc-600">{m.k}</div>
              <div className="mt-0.5 font-mono text-sm text-amber-400">{m.v}</div>
            </div>
          ))}
        </div>

        {/* perf banner */}
        {parallelCount > 0 && (
          <div className="flex flex-wrap items-center gap-3 border-b border-zinc-800 bg-emerald-500/[0.06] px-5 py-2.5 text-xs">
            <Zap className="h-3.5 w-3.5 text-emerald-400" />
            <span className="text-emerald-300">
              {parallelCount} parallel tool calls executed · {toolMs > 0 && wallMs ? `${(toolMs / Math.max(1, wallMs)).toFixed(1)}× lane utilization` : 'running now'}
            </span>
            {speedups.length > 0 && <span className="font-mono text-emerald-500/80">Σ lane-time {toolMs}ms</span>}
          </div>
        )}

        <div className="grid gap-0 lg:grid-cols-[1fr_280px]">
          {/* steps */}
          <div className="max-h-[520px] space-y-2.5 overflow-y-auto p-5 [scrollbar-width:thin]">
            {steps.length === 0 && (
              <div className="flex items-center justify-center gap-2 py-12 text-sm text-zinc-600">
                {isLive ? <><Loader2 className="h-4 w-4 animate-spin" /> waiting for first step…</> : 'No steps recorded'}
              </div>
            )}
            {steps.map((s) => (
              <StepRow key={s.id} step={s} />
            ))}
            {t.result && (
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/[0.06] p-4">
                <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-emerald-400">
                  <Flag className="h-3.5 w-3.5" /> Final answer
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-zinc-300">{t.result}</p>
              </div>
            )}
            {t.error && (
              <div className="rounded-lg border border-red-500/30 bg-red-500/[0.06] p-4 text-sm text-red-300">{t.error}</div>
            )}
          </div>

          {/* prompt + plan */}
          <div className="border-t border-zinc-800 p-5 lg:border-l lg:border-t-0">
            <div className="text-[10px] uppercase tracking-wider text-zinc-600">Prompt</div>
            <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">{t.prompt}</p>
            {t.sandbox && (
              <>
                <div className="mt-4 text-[10px] uppercase tracking-wider text-zinc-600">Sandbox</div>
                <button className="mt-1.5 font-mono text-xs text-amber-400 hover:underline" onClick={() => navigate('terminal', { sandboxId: t.sandbox!.id })}>
                  {t.sandbox.name} →
                </button>
              </>
            )}
            {t.strategy === 'dag' && t.plan && (
              <>
                <div className="mt-4 text-[10px] uppercase tracking-wider text-zinc-600">Planned DAG</div>
                <pre className="mt-1.5 max-h-52 overflow-auto whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-950/60 p-2.5 font-mono text-[10.5px] leading-relaxed text-zinc-400 [scrollbar-width:thin]">
                  {(() => {
                    try {
                      const plan = JSON.parse(t.plan) as { title: string; tool: string; dependsOn: number[] }[]
                      return plan.map((p, i) => `${i}. ${p.title}\n   ↳ ${p.tool}${p.dependsOn.length ? ` (after ${p.dependsOn.join(',')})` : ' (wave 1)'}`).join('\n')
                    } catch {
                      return t.plan
                    }
                  })()}
                </pre>
              </>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function StepRow({ step }: { step: TaskStep }) {
  const [open, setOpen] = useState(false)
  const icon =
    step.kind === 'thought' ? <Brain className="h-3.5 w-3.5 text-violet-400" />
    : step.kind === 'final' ? <Flag className="h-3.5 w-3.5 text-emerald-400" />
    : step.status === 'error' ? <XCircle className="h-3.5 w-3.5 text-red-400" />
    : step.status === 'running' ? <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-400" />
    : <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />

  return (
    <div className={cn('rounded-lg border transition-colors', step.status === 'running' ? 'border-amber-500/40 bg-amber-500/[0.05]' : 'border-zinc-800 bg-zinc-950/40')}>
      <button className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left" onClick={() => setOpen((v) => !v)}>
        {icon}
        <span className="font-mono text-[10px] text-zinc-600">#{step.idx}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-zinc-300">
          {step.kind === 'thought' ? step.output.slice(0, 140) || '(thinking…)' : step.kind === 'final' ? 'final answer' : `${step.tool}: ${step.input.slice(0, 100)}`}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          {step.parallel && <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 px-1 text-[9px] text-amber-400">⚡ par</Badge>}
          {step.durationMs != null && <span className="font-mono text-[10px] text-zinc-600">{step.durationMs}ms</span>}
        </div>
      </button>
      {open && (
        <div className="space-y-2 border-t border-zinc-800/70 px-3.5 py-2.5">
          {step.input && step.kind === 'tool_call' && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-zinc-600">Input</div>
              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded border border-zinc-800 bg-black/40 p-2 font-mono text-[11px] text-zinc-400">{step.input}</pre>
            </div>
          )}
          {step.output && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-zinc-600">Output</div>
              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded border border-zinc-800 bg-black/40 p-2 font-mono text-[11px] leading-relaxed text-zinc-400 [scrollbar-width:thin]">{step.output}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── create dialog ────────────────────────────────────────────
function CreateTaskDialog({
  open, onOpenChange, onCreated, prefillSandbox,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onCreated: (id: string) => void
  prefillSandbox?: string | null
}) {
  const fleet = usePoll<{ sandboxes: Sandbox[] }>('/sandboxes', 8000, [open])
  const [prompt, setPrompt] = useState('')
  const [name, setName] = useState('')
  const [sandboxId, setSandboxId] = useState<string>(prefillSandbox ?? '')
  const [strategy, setStrategy] = useState('react')
  const [maxSteps, setMaxSteps] = useState(8)
  const [toolConcurrency, setToolConcurrency] = useState(4)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (open && !sandboxId && fleet.data?.sandboxes.length) {
      setSandboxId(fleet.data.sandboxes[0].id)
    }
  }, [open, fleet.data, sandboxId])

  const submit = async () => {
    if (!prompt.trim()) return
    setSubmitting(true)
    try {
      const { task } = await api<{ task: AgentTask }>('/tasks', {
        method: 'POST',
        body: JSON.stringify({ prompt, name: name || undefined, sandboxId: sandboxId || undefined, strategy, maxSteps, toolConcurrency }),
      })
      toast.success('Task dispatched — streaming steps now')
      onCreated(task.id)
      onOpenChange(false)
      setPrompt('')
      setName('')
    } catch (e) {
      toast.error(String((e as Error).message ?? e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto border-zinc-800 bg-zinc-900 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-zinc-100">
            <Sparkles className="h-4 w-4 text-amber-500" /> Dispatch agent task
          </DialogTitle>
          <DialogDescription className="text-zinc-500">
            The agent plans, uses tools (exec, files, web search), and batches independent tool calls for parallel execution.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-1">
          <div className="space-y-1.5">
            <Label className="text-zinc-400">Goal / prompt</Label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder="e.g. Audit this sandbox, list all files, check runtimes, write SUMMARY.md"
              className="w-full resize-none rounded-md border border-zinc-700 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-700 focus:border-amber-500/50"
            />
            <div className="flex flex-wrap gap-1.5 pt-1">
              {SAMPLE_PROMPTS.map((p) => (
                <button key={p.label} onClick={() => setPrompt(p.text)} className="rounded border border-zinc-800 bg-zinc-950/50 px-2 py-0.5 text-[11px] text-zinc-500 transition-colors hover:border-amber-500/40 hover:text-amber-300">
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-zinc-400">Sandbox</Label>
              <Select value={sandboxId} onValueChange={setSandboxId}>
                <SelectTrigger className="border-zinc-700 bg-zinc-950/60"><SelectValue placeholder="none" /></SelectTrigger>
                <SelectContent className="border-zinc-800 bg-zinc-900">
                  {(fleet.data?.sandboxes ?? []).map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-zinc-400">Strategy</Label>
              <Select value={strategy} onValueChange={setStrategy}>
                <SelectTrigger className="border-zinc-700 bg-zinc-950/60"><SelectValue /></SelectTrigger>
                <SelectContent className="border-zinc-800 bg-zinc-900">
                  <SelectItem value="react">ReAct — adaptive loop</SelectItem>
                  <SelectItem value="dag">DAG — plan, parallel waves</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-zinc-400">Max steps <span className="font-mono text-amber-400">{maxSteps}</span></Label>
              <Slider value={[maxSteps]} min={2} max={24} step={1} onValueChange={([v]) => setMaxSteps(v)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-zinc-400">Tool lanes <span className="font-mono text-amber-400">{toolConcurrency}</span></Label>
              <Slider value={[toolConcurrency]} min={1} max={8} step={1} onValueChange={([v]) => setToolConcurrency(v)} />
            </div>
          </div>

          <div className="flex items-start gap-2.5 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 text-[11px] leading-relaxed text-zinc-500">
            <Wrench className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
            <span>
              Tools: <span className="font-mono text-zinc-400">exec · read_file · write_file · list_files · web_search · metrics · snapshot</span>.
              With <span className="font-mono text-amber-400">{toolConcurrency}</span> lanes, {toolConcurrency} independent tools run simultaneously.
            </span>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} className="border-zinc-700 bg-zinc-950/60 text-zinc-400">Cancel</Button>
          <Button onClick={() => void submit()} disabled={submitting || !prompt.trim()} className="bg-amber-500 font-semibold text-zinc-950 hover:bg-amber-400">
            {submitting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Play className="mr-1 h-4 w-4" />} Dispatch
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
