'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import { KeyRound, Plus, Trash2, Copy, Check, Loader2, Terminal } from 'lucide-react'
import { api, usePoll, fmtAgo } from './lib'
import { SectionTitle } from './ui-bits'

interface KeyRow {
  id: string
  name: string
  prefix: string
  scopes: string
  lastUsedAt?: string | null
  createdAt: string
}

const ENDPOINTS = [
  { method: 'GET', path: '/v1/templates', desc: 'List template catalog' },
  { method: 'POST', path: '/v1/sandboxes', desc: 'Provision + boot a sandbox' },
  { method: 'GET', path: '/v1/sandboxes', desc: 'List fleet with statuses' },
  { method: 'POST', path: '/v1/sandboxes/:id/action', desc: 'start · stop · hibernate · fork · snapshot' },
  { method: 'POST', path: '/v1/sandboxes/:id/exec', desc: 'Execute a command in the workspace' },
  { method: 'POST', path: '/v1/agent-tasks', desc: 'Dispatch an agent task (react | dag)' },
  { method: 'GET', path: '/v1/agent-tasks/:id', desc: 'Task status + full step timeline' },
  { method: 'GET', path: '/v1/cost', desc: 'Spend, savings, waste detection' },
  { method: 'WS', path: '/?XTransformPort=3003', desc: 'Live event stream + web terminal' },
]

export function ApiView() {
  const keys = usePoll<{ keys: KeyRow[] }>('/keys', 10000)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [freshSecret, setFreshSecret] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const create = async () => {
    setCreating(true)
    try {
      const { secret } = await api<{ secret: string }>('/keys', { method: 'POST', body: JSON.stringify({ name: name || undefined }) })
      setFreshSecret(secret)
      setName('')
      keys.refresh()
      toast.success('API key created — copy it now, shown once')
    } catch (e) {
      toast.error(String((e as Error).message ?? e))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="space-y-6">
      <SectionTitle title="API" sub="Everything the console does is one REST call away" />

      {/* create key */}
      <Card className="border-zinc-800 bg-zinc-900/50">
        <CardContent className="p-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
            <KeyRound className="h-4 w-4 text-amber-500" /> API keys
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <div className="grid flex-1 gap-1.5 sm:max-w-xs">
              <Label className="text-zinc-500">Key name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ci-pipeline" className="border-zinc-700 bg-zinc-950/60 font-mono text-sm" />
            </div>
            <Button onClick={() => void create()} disabled={creating} className="mt-auto bg-amber-500 font-semibold text-zinc-950 hover:bg-amber-400">
              {creating ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />} Create key
            </Button>
          </div>

          {freshSecret && (
            <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/[0.07] p-3">
              <Terminal className="h-4 w-4 shrink-0 text-amber-500" />
              <code className="min-w-0 flex-1 break-all font-mono text-xs text-amber-300">{freshSecret}</code>
              <Button
                size="sm" variant="outline"
                className="h-7 border-amber-500/40 bg-transparent text-xs text-amber-300 hover:bg-amber-500/10"
                onClick={() => { void navigator.clipboard.writeText(freshSecret); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
              >
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              </Button>
            </div>
          )}

          <div className="mt-4 divide-y divide-zinc-800/60">
            {(keys.data?.keys ?? []).length === 0 && <div className="py-6 text-center text-sm text-zinc-600">No keys yet.</div>}
            {(keys.data?.keys ?? []).map((k) => (
              <div key={k.id} className="flex items-center justify-between py-2.5">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="text-sm text-zinc-200">{k.name}</span>
                  <code className="rounded border border-zinc-800 bg-zinc-950/60 px-1.5 py-0.5 font-mono text-[11px] text-zinc-500">{k.prefix}.••••••</code>
                  <span className="hidden font-mono text-[11px] text-zinc-600 sm:inline">{k.scopes}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-[11px] text-zinc-600">created {fmtAgo(k.createdAt)}</span>
                  <Button
                    size="sm" variant="ghost"
                    className="h-7 w-7 p-0 text-zinc-600 hover:text-red-400"
                    onClick={() => void api(`/keys?id=${k.id}`, { method: 'DELETE' }).then(() => { keys.refresh(); toast.success('Key revoked') })}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* endpoints */}
      <Card className="border-zinc-800 bg-zinc-900/50">
        <CardContent className="p-0">
          <div className="border-b border-zinc-800 px-5 py-3.5 text-sm font-semibold text-zinc-200">Endpoints</div>
          <div className="divide-y divide-zinc-800/60">
            {ENDPOINTS.map((e) => (
              <div key={e.path + e.method} className="flex flex-wrap items-center gap-3 px-5 py-2.5">
                <Badge
                  variant="outline"
                  className={cn2(
                    'w-14 justify-center font-mono text-[10px]',
                    e.method === 'GET' ? 'border-emerald-500/40 text-emerald-400' :
                    e.method === 'POST' ? 'border-amber-500/40 text-amber-400' :
                    'border-sky-500/40 text-sky-300'
                  )}
                >
                  {e.method}
                </Badge>
                <code className="font-mono text-xs text-zinc-300">{e.path}</code>
                <span className="ml-auto text-xs text-zinc-600">{e.desc}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* curl examples */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="overflow-hidden border-zinc-800 bg-zinc-950">
          <div className="border-b border-zinc-800 px-4 py-2.5 font-mono text-xs text-zinc-500">create + fork</div>
          <pre className="overflow-x-auto p-4 font-mono text-[11.5px] leading-relaxed text-zinc-300">{`# provision
curl -X POST $FLINT/api/flint/sandboxes \\
  -H 'content-type: application/json' \\
  -d '{"template":"node-22","vcpu":4,"memoryGb":8}'

# fork it (O(1) COW)
curl -X POST $FLINT/api/flint/sandboxes/$ID/action \\
  -d '{"action":"fork","name":"test-pr-42"}'`}</pre>
        </Card>
        <Card className="overflow-hidden border-zinc-800 bg-zinc-950">
          <div className="border-b border-zinc-800 px-4 py-2.5 font-mono text-xs text-zinc-500">agent task with parallel tools</div>
          <pre className="overflow-x-auto p-4 font-mono text-[11.5px] leading-relaxed text-zinc-300">{`curl -X POST $FLINT/api/flint/tasks \\
  -H 'content-type: application/json' \\
  -d '{
    "prompt": "audit deps and fix CVEs",
    "strategy": "dag",
    "toolConcurrency": 6,
    "maxSteps": 10,
    "sandboxId": "'$ID'"
  }'

# steps stream live over WebSocket`}</pre>
        </Card>
      </div>
    </div>
  )
}

function cn2(...parts: (string | false | undefined)[]) {
  return parts.filter(Boolean).join(' ')
}
