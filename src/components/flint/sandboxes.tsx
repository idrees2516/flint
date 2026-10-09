'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { toast } from 'sonner'
import {
  Server, Plus, Play, Square, Snowflake, GitFork, Camera, Trash2, Terminal as TerminalIcon,
  MoreHorizontal, Loader2, Boxes,
} from 'lucide-react'
import { api, usePoll, useFlintEvents, fmtAgo, mb, navigate, type Sandbox, type Template } from './lib'
import { StatusBadge, SectionTitle, TemplateIcon, Empty } from './ui-bits'
import { cn } from '@/lib/utils'

const REGIONS = ['us-east-1', 'us-west-2', 'eu-west-1', 'ap-south-1']

export function Sandboxes() {
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  const fleet = usePoll<{ sandboxes: Sandbox[] }>('/sandboxes', 3500)
  const templates = usePoll<{ templates: Template[] }>('/templates', 60000)
  useFlintEvents((e) => {
    if (e.type.startsWith('sandbox:') || e.type === 'snapshot:created') fleet.refresh()
  })

  const sandboxes = fleet.data?.sandboxes ?? []

  const act = async (id: string, action: string, name?: string) => {
    setBusy(`${id}:${action}`)
    try {
      const res = await api<{ result?: { forkMs?: number; mode?: string; snapshotMb?: number } }>(`/sandboxes/${id}/action`, {
        method: 'POST',
        body: JSON.stringify({ action, name }),
      })
      if (action === 'fork' && res.result) {
        toast.success(`Forked in ${res.result.forkMs}ms (${res.result.mode})`)
      } else if (action === 'snapshot' && res.result) {
        toast.success(`Snapshot saved — ${mb(res.result.snapshotMb)}`)
      }
      fleet.refresh()
    } catch (e) {
      toast.error(String((e as Error).message ?? e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Fleet manager"
        sub={`${sandboxes.length} sandboxes · per-second metering · auto-hibernate armed`}
        right={
          <Button size="sm" className="bg-amber-500 font-semibold text-zinc-950 hover:bg-amber-400" onClick={() => setCreating(true)}>
            <Plus className="mr-1.5 h-4 w-4" /> New sandbox
          </Button>
        }
      />

      {fleet.loading && sandboxes.length === 0 ? (
        <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-amber-500" /></div>
      ) : sandboxes.length === 0 ? (
        <Empty
          icon={Boxes}
          title="No sandboxes yet"
          sub="Provision your first sandbox from a template — boots in ~500ms, billed per second."
          action={<Button size="sm" className="bg-amber-500 font-semibold text-zinc-950 hover:bg-amber-400" onClick={() => setCreating(true)}><Plus className="mr-1.5 h-4 w-4" /> New sandbox</Button>}
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {sandboxes.map((s) => (
            <Card key={s.id} className="group border-zinc-800 bg-zinc-900/50 transition-colors hover:border-zinc-700">
              <CardContent className="p-5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <button
                      className="truncate font-mono text-sm font-semibold text-zinc-100 hover:text-amber-400"
                      onClick={() => navigate('terminal', { sandboxId: s.id })}
                      title="Open terminal"
                    >
                      {s.name}
                    </button>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500">
                      <span className="rounded border border-zinc-800 bg-zinc-950/60 px-1.5 py-0.5 font-mono">{s.driver}</span>
                      <span>{s.region}</span>
                      <span>·</span>
                      <span className="font-mono">{s.vcpu}c/{s.memoryGb}g/{s.diskGb}g</span>
                    </div>
                  </div>
                  <StatusBadge status={s.status} />
                </div>

                {s.template && (
                  <div className="mt-3 flex items-center gap-2 rounded-lg border border-zinc-800/80 bg-zinc-950/40 px-2.5 py-1.5">
                    <TemplateIcon icon={s.template.icon} className="h-3.5 w-3.5 text-amber-500" />
                    <span className="text-xs text-zinc-400">{s.template.name}</span>
                    {s.parentId && <Badge variant="outline" className="ml-auto border-amber-500/40 bg-amber-500/10 px-1.5 text-[10px] text-amber-400">fork</Badge>}
                  </div>
                )}

                <div className="mt-3 flex items-center justify-between text-[11px] text-zinc-600">
                  <span>active {fmtAgo(s.lastActiveAt)}</span>
                  <span className="font-mono">sleep @ {s.hibernateAfterMin}m idle</span>
                </div>

                {/* actions */}
                <div className="mt-4 flex items-center gap-1.5">
                  {s.status === 'running' ? (
                    <>
                      <Button size="sm" variant="outline" className="h-8 flex-1 border-zinc-700 bg-zinc-950/60 text-xs hover:border-amber-500/50 hover:text-amber-300" onClick={() => navigate('terminal', { sandboxId: s.id })}>
                        <TerminalIcon className="mr-1 h-3.5 w-3.5 text-amber-500" /> Shell
                      </Button>
                      <IconBtn title="Stop (billing pauses)" busy={busy === `${s.id}:stop`} onClick={() => void act(s.id, 'stop')}><Square className="h-3.5 w-3.5" /></IconBtn>
                      <IconBtn title="Hibernate (snapshot-only pricing)" busy={busy === `${s.id}:hibernate`} onClick={() => void act(s.id, 'hibernate')}><Snowflake className="h-3.5 w-3.5" /></IconBtn>
                    </>
                  ) : (
                    <Button size="sm" variant="outline" disabled={busy === `${s.id}:start`} className="h-8 flex-1 border-zinc-700 bg-zinc-950/60 text-xs hover:border-emerald-500/50 hover:text-emerald-300" onClick={() => void act(s.id, 'start')}>
                      {busy === `${s.id}:start` ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1 h-3.5 w-3.5 text-emerald-400" />} Resume
                    </Button>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" variant="outline" className="h-8 w-8 border-zinc-700 bg-zinc-950/60 p-0 hover:border-amber-500/50">
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="border-zinc-800 bg-zinc-900">
                      <DropdownMenuItem onClick={() => void act(s.id, 'fork', `${s.name}-fork`)} className="gap-2 text-xs">
                        <GitFork className="h-3.5 w-3.5 text-amber-500" /> Fork (O(1) COW)
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => void act(s.id, 'snapshot', `snap-${new Date().toISOString().slice(11, 19)}`)} className="gap-2 text-xs">
                        <Camera className="h-3.5 w-3.5 text-amber-500" /> Snapshot
                      </DropdownMenuItem>
                      <DropdownMenuSeparator className="bg-zinc-800" />
                      <DropdownMenuItem onClick={() => navigate('agents', { sandboxId: s.id })} className="gap-2 text-xs">
                        <Server className="h-3.5 w-3.5 text-amber-500" /> Attach agent task
                      </DropdownMenuItem>
                      <DropdownMenuSeparator className="bg-zinc-800" />
                      <DropdownMenuItem onClick={() => void api(`/sandboxes/${s.id}`, { method: 'DELETE' }).then(() => { toast.success('Destroying…'); fleet.refresh() })} className="gap-2 text-xs text-red-400 focus:text-red-300">
                        <Trash2 className="h-3.5 w-3.5" /> Destroy
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <CreateDialog open={creating} onOpenChange={setCreating} templates={templates.data?.templates ?? []} onCreated={() => { fleet.refresh(); toast.success('Provisioning dispatched to worker pool') }} />
    </div>
  )
}

function IconBtn({ children, title, onClick, busy }: { children: React.ReactNode; title: string; onClick: () => void; busy?: boolean }) {
  return (
    <Button size="sm" variant="outline" title={title} onClick={onClick} disabled={busy} className="h-8 w-8 border-zinc-700 bg-zinc-950/60 p-0 hover:border-amber-500/50">
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : children}
    </Button>
  )
}

function CreateDialog({
  open, onOpenChange, templates, onCreated,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  templates: Template[]
  onCreated: () => void
}) {
  const [name, setName] = useState('')
  const [templateSlug, setTemplateSlug] = useState('ubuntu-24-04')
  const [driver, setDriver] = useState('local')
  const [region, setRegion] = useState('us-east-1')
  const [vcpu, setVcpu] = useState(2)
  const [mem, setMem] = useState(4)
  const [disk, setDisk] = useState(20)
  const [hib, setHib] = useState(15)
  const [autostart, setAutostart] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  const hourly = (vcpu * 0.00000111 + mem * 0.00000022) * 3600

  const submit = async () => {
    setSubmitting(true)
    try {
      await api('/sandboxes', {
        method: 'POST',
        body: JSON.stringify({ name: name || undefined, template: templateSlug, driver, region, vcpu, memoryGb: mem, diskGb: disk, hibernateAfterMin: hib, autostart }),
      })
      onCreated()
      onOpenChange(false)
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
          <DialogTitle className="text-zinc-100">Provision sandbox</DialogTitle>
          <DialogDescription className="text-zinc-500">Boots in ~500ms. Billed per second — free the moment it stops.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-zinc-400">Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="flint-build-runner" className="border-zinc-700 bg-zinc-950/60 font-mono text-sm" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-zinc-400">Driver</Label>
              <Select value={driver} onValueChange={setDriver}>
                <SelectTrigger className="border-zinc-700 bg-zinc-950/60"><SelectValue /></SelectTrigger>
                <SelectContent className="border-zinc-800 bg-zinc-900">
                  <SelectItem value="local">local — real processes</SelectItem>
                  <SelectItem value="cloud-vm">cloud-vm — full VM (sim)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-zinc-400">Template</Label>
            <div className="grid max-h-40 grid-cols-2 gap-1.5 overflow-y-auto pr-1">
              {(templates.length ? templates : [{ slug: 'ubuntu-24-04', name: 'Ubuntu 24.04 LTS', icon: 'terminal', category: 'runtime', description: '', id: '', baseImage: '', tags: '', bootSeconds: 0, sizeMb: 0, launches: 0, isOfficial: true }] as Template[]).map((t) => (
                <button
                  key={t.slug}
                  onClick={() => setTemplateSlug(t.slug)}
                  className={cn(
                    'flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-xs transition-colors',
                    templateSlug === t.slug ? 'border-amber-500/60 bg-amber-500/10 text-amber-300' : 'border-zinc-800 bg-zinc-950/60 text-zinc-400 hover:border-zinc-700'
                  )}
                >
                  <TemplateIcon icon={t.icon} className="h-4 w-4 shrink-0 text-amber-500" />
                  <span className="truncate">{t.name}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label className="text-zinc-400">vCPU <span className="font-mono text-amber-400">{vcpu}</span></Label>
              <Slider value={[vcpu]} min={1} max={32} step={1} onValueChange={([v]) => setVcpu(v)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-zinc-400">RAM <span className="font-mono text-amber-400">{mem}GB</span></Label>
              <Slider value={[mem]} min={1} max={64} step={1} onValueChange={([v]) => setMem(v)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-zinc-400">Disk <span className="font-mono text-amber-400">{disk}GB</span></Label>
              <Slider value={[disk]} min={5} max={128} step={5} onValueChange={([v]) => setDisk(v)} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-zinc-400">Region</Label>
              <Select value={region} onValueChange={setRegion}>
                <SelectTrigger className="border-zinc-700 bg-zinc-950/60"><SelectValue /></SelectTrigger>
                <SelectContent className="border-zinc-800 bg-zinc-900">
                  {REGIONS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-zinc-400">Auto-hibernate <span className="font-mono text-amber-400">{hib}m</span></Label>
              <Slider value={[hib]} min={1} max={120} step={1} onValueChange={([v]) => setHib(v)} />
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2.5">
            <div className="text-xs text-zinc-400">Boot immediately</div>
            <Switch checked={autostart} onCheckedChange={setAutostart} />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2.5">
            <div className="text-xs text-zinc-400">Rate</div>
            <div className="font-mono text-sm font-semibold text-amber-400">${hourly.toFixed(4)}/hr · ${(hourly / 3600).toFixed(6)}/s</div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} className="border-zinc-700 bg-zinc-950/60 text-zinc-400">Cancel</Button>
          <Button onClick={() => void submit()} disabled={submitting} className="bg-amber-500 font-semibold text-zinc-950 hover:bg-amber-400">
            {submitting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />} Provision
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
