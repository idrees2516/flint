'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Loader2, TerminalSquare, RefreshCw, FolderTree } from 'lucide-react'
import { usePoll, useFlintEvents, flintSocket, navigate, type Sandbox, type FlintEventPayload } from './lib'
import { SectionTitle, StatusBadge } from './ui-bits'
import { cn } from '@/lib/utils'

interface Line {
  id: number
  kind: 'cmd' | 'out' | 'err' | 'sys'
  text: string
}

const WELCOME: Line[] = [
  { id: -3, kind: 'sys', text: 'flint web shell — real process execution in the sandbox workspace' },
  { id: -2, kind: 'sys', text: 'try: ls -la · cat README.md · echo "hello from $FLINT_SANDBOX" · node -v · python3 --version' },
  { id: -1, kind: 'sys', text: 'auto-hibernate timer resets on every command' },
]

export function TerminalView({ sandboxId }: { sandboxId?: string | null }) {
  const fleet = usePoll<{ sandboxes: Sandbox[] }>('/sandboxes', 5000)
  const sandboxes = fleet.data?.sandboxes ?? []
  const active = sandboxes.find((s) => s.id === sandboxId) ?? sandboxes[0]

  return (
    <div className="space-y-4">
      <SectionTitle
        title="Web shell"
        sub="Real processes in the sandbox workspace · streaming over WebSocket"
        right={
          <div className="flex flex-wrap items-center gap-1.5">
            {sandboxes.length === 0 ? (
              <span className="text-sm text-zinc-600">no sandboxes — create one first</span>
            ) : (
              sandboxes.slice(0, 6).map((s) => (
                <button
                  key={s.id}
                  onClick={() => navigate('terminal', { sandboxId: s.id })}
                  className={cn(
                    'rounded-md border px-2.5 py-1 font-mono text-xs transition-colors',
                    s.id === active?.id ? 'border-amber-500/60 bg-amber-500/10 text-amber-300' : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700'
                  )}
                >
                  {s.name}
                </button>
              ))
            )}
          </div>
        }
      />

      {!active ? (
        <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-amber-500" /></div>
      ) : (
        <TerminalBody key={active.id} sandbox={active} />
      )}
    </div>
  )
}

function TerminalBody({ sandbox: active }: { sandbox: Sandbox }) {
  const [lines, setLines] = useState<Line[]>(WELCOME)
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [files, setFiles] = useState<string[]>([])
  const [showFiles, setShowFiles] = useState(true)
  const seqRef = useRef(0)
  const idRef = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const push = useCallback((kind: Line['kind'], text: string) => {
    setLines((ls) => [...ls, { id: idRef.current++, kind, text }].slice(-500))
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  useEffect(() => {
    const s = flintSocket()
    s.emit('files:list', { sandboxId: active.id })

    const onOut = (m: { seq: number; stdout?: string; stderr?: string; exitCode?: number; done?: boolean; durationMs?: number }) => {
      if (m.seq !== seqRef.current) return
      if (m.stdout) push('out', m.stdout.replace(/\n$/, ''))
      if (m.stderr) push('err', m.stderr.replace(/\n$/, ''))
      if (m.done) {
        setRunning(false)
        push('sys', `↳ exit ${m.exitCode} · ${m.durationMs}ms`)
        s.emit('files:list', { sandboxId: active.id })
      }
    }
    const onFiles = (m: { sandboxId: string; files: string[] }) => {
      if (m.sandboxId === active.id) setFiles(m.files)
    }
    s.on('terminal:out', onOut)
    s.on('files:list', onFiles)
    return () => {
      s.off('terminal:out', onOut)
      s.off('files:list', onFiles)
    }
  }, [active.id, push])

  useFlintEvents((e: FlintEventPayload) => {
    if (e.refId === active.id && e.type.startsWith('sandbox:')) push('sys', `ⓘ ${e.message}`)
  })

  const run = () => {
    const cmd = input.trim()
    if (!cmd || running) return
    setInput('')
    seqRef.current++
    setRunning(true)
    push('cmd', cmd)
    if (cmd === 'clear') {
      setLines([])
      setRunning(false)
      return
    }
    flintSocket().emit('terminal:exec', { sandboxId: active.id, cmd, seq: seqRef.current })
    // safety fallback: unblock the input after 20s
    setTimeout(() => setRunning(false), 20000)
  }

  const quickCmds = ['ls -la', 'cat README.md', 'df -h / | tail -1', 'uname -a', 'ps aux | head -5']

  return (
    <div className={cn('grid gap-4', showFiles ? 'lg:grid-cols-[1fr_260px]' : 'grid-cols-1')}>
      {/* terminal */}
      <Card className="overflow-hidden border-zinc-800 bg-zinc-950">
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <TerminalSquare className="h-4 w-4 text-amber-500" />
            <span className="font-mono text-xs text-zinc-300">{active.name}</span>
            <StatusBadge status={active.status} />
          </div>
          <div className="flex items-center gap-1.5">
            <Badge variant="outline" className="border-zinc-800 font-mono text-[10px] text-zinc-500">{active.driver}</Badge>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-zinc-500 hover:text-amber-400" title="Toggle file browser" onClick={() => setShowFiles((v) => !v)}>
              <FolderTree className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div ref={scrollRef} className="h-[440px] overflow-y-auto px-4 py-3 font-mono text-[12.5px] leading-relaxed [scrollbar-width:thin]">
          {lines.map((l) => (
            <div key={l.id} className={cn('whitespace-pre-wrap break-words', l.kind === 'cmd' ? 'mt-1.5 text-zinc-100' : l.kind === 'err' ? 'text-red-400' : l.kind === 'sys' ? 'text-zinc-600' : 'text-zinc-400')}>
              {l.kind === 'cmd' && <span className="mr-1.5 text-amber-400">$</span>}
              {l.text}
            </div>
          ))}
          {running && <div className="flex items-center gap-1.5 text-zinc-600"><Loader2 className="h-3 w-3 animate-spin" /> running…</div>}
        </div>

        <div className="flex items-center gap-2 border-t border-zinc-800 px-4 py-3">
          <span className="font-mono text-sm text-amber-400">$</span>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && run()}
            placeholder={running ? 'waiting…' : 'type a command · enter to run'}
            disabled={running}
            className="flex-1 bg-transparent font-mono text-sm text-zinc-100 outline-none placeholder:text-zinc-700 disabled:opacity-50"
            spellCheck={false}
          />
          <Button size="sm" className="h-7 bg-amber-500 px-3 font-semibold text-zinc-950 hover:bg-amber-400" disabled={running || !input.trim()} onClick={run}>
            Run
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 border-t border-zinc-800/60 px-4 py-2">
          {quickCmds.map((c) => (
            <button
              key={c}
              onClick={() => { if (!running) { setInput(c); inputRef.current?.focus() } }}
              className="rounded border border-zinc-800 bg-zinc-900/60 px-2 py-0.5 font-mono text-[11px] text-zinc-500 transition-colors hover:border-amber-500/40 hover:text-amber-300"
            >
              {c}
            </button>
          ))}
        </div>
      </Card>

      {/* file browser */}
      {showFiles && (
        <Card className="h-fit border-zinc-800 bg-zinc-900/50">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                <FolderTree className="h-3.5 w-3.5 text-amber-500" /> Workspace
              </div>
              <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-zinc-500 hover:text-amber-400" onClick={() => flintSocket().emit('files:list', { sandboxId: active.id })}>
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="mt-3 max-h-[440px] space-y-0.5 overflow-y-auto pr-1 [scrollbar-width:thin]">
              {files.length === 0 && <div className="py-6 text-center text-xs text-zinc-600">{active.driver === 'cloud-vm' ? 'VM workspace — use the shell' : 'No files listed yet'}</div>}
              {files.map((f) => {
                const rel = f.split('/sandbox').pop() ?? f
                return (
                  <div key={f} className="flex items-center gap-1.5 rounded px-1.5 py-1 font-mono text-[11px] text-zinc-400 hover:bg-zinc-800/50" title={f}>
                    <span className="h-3 w-3 shrink-0 rounded-sm border border-zinc-700" />
                    <span className="truncate">{rel || '/'}</span>
                  </div>
                )
              })}
            </div>
            <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/50 p-2.5 text-[11px] leading-relaxed text-zinc-500">
              <div className="mb-1 font-semibold text-zinc-400">This sandbox</div>
              <div className="font-mono">{active.vcpu}c · {active.memoryGb}g · {active.diskGb}g</div>
              <div className="font-mono">{active.region} · {active.template?.name ?? 'blank'}</div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
