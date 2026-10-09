'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import { Rocket, Loader2 } from 'lucide-react'
import { api, usePoll, navigate, type Template } from './lib'
import { SectionTitle, TemplateIcon } from './ui-bits'
import { cn } from '@/lib/utils'

const CATEGORY_LABEL: Record<string, string> = {
  runtime: 'Runtime',
  desktop: 'Desktop',
  data: 'Data / ML',
  browser: 'Browser',
  custom: 'Custom',
}

export function TemplatesView() {
  const [launching, setLaunching] = useState<string | null>(null)
  const tpl = usePoll<{ templates: Template[] }>('/templates', 30000)
  const templates = tpl.data?.templates ?? []
  const categories = [...new Set(templates.map((t) => t.category))]

  const launch = async (t: Template) => {
    setLaunching(t.slug)
    try {
      await api('/sandboxes', {
        method: 'POST',
        body: JSON.stringify({ template: t.slug, name: `${t.slug}-${Math.random().toString(36).slice(2, 5)}`, driver: t.slug === 'desktop-chrome' || t.slug === 'cuda-gpu' ? 'cloud-vm' : 'local' }),
      })
      toast.success(`${t.name} provisioning — flipping to running in ~${t.bootSeconds}s`)
      navigate('sandboxes')
    } catch (e) {
      toast.error(String((e as Error).message ?? e))
      setLaunching(null)
    }
  }

  return (
    <div className="space-y-6">
      <SectionTitle title="Templates" sub={`${templates.length} official images — every sandbox ships ready-to-work · zero config`} />

      {tpl.loading && templates.length === 0 ? (
        <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-amber-500" /></div>
      ) : (
        categories.map((cat) => (
          <div key={cat}>
            <div className="mb-3 flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-widest text-zinc-500">{CATEGORY_LABEL[cat] ?? cat}</span>
              <span className="font-mono text-[11px] text-zinc-700">{templates.filter((t) => t.category === cat).length}</span>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {templates.filter((t) => t.category === cat).map((t) => (
                <Card key={t.id} className="group flex flex-col border-zinc-800 bg-zinc-900/50 transition-colors hover:border-amber-500/40">
                  <CardContent className="flex flex-1 flex-col p-5">
                    <div className="flex items-start justify-between">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/10">
                        <TemplateIcon icon={t.icon} className="h-5 w-5 text-amber-500" />
                      </div>
                      <Badge variant="outline" className="border-zinc-800 font-mono text-[10px] text-zinc-500">{t.baseImage}</Badge>
                    </div>
                    <div className="mt-3.5 font-semibold text-zinc-100">{t.name}</div>
                    <p className="mt-1.5 flex-1 text-[13px] leading-relaxed text-zinc-500">{t.description}</p>
                    <div className="mt-4 flex flex-wrap gap-1">
                      {t.tags.split(',').filter(Boolean).map((tag) => (
                        <span key={tag} className="rounded border border-zinc-800 bg-zinc-950/50 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">{tag}</span>
                      ))}
                    </div>
                    <div className="mt-4 flex items-center justify-between border-t border-zinc-800/70 pt-3.5">
                      <div className="flex items-center gap-3 text-[11px] text-zinc-600">
                        <span className="font-mono">boot ~{t.bootSeconds}s</span>
                        <span className="font-mono">{(t.sizeMb / 1024).toFixed(1)}GB</span>
                        <span className="font-mono">{t.launches} ↗</span>
                      </div>
                      <Button
                        size="sm"
                        disabled={launching === t.slug}
                        onClick={() => void launch(t)}
                        className={cn('h-8 font-semibold', launching === t.slug ? 'bg-zinc-700 text-zinc-300' : 'bg-amber-500 text-zinc-950 hover:bg-amber-400')}
                      >
                        {launching === t.slug ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Rocket className="mr-1 h-3.5 w-3.5" />}
                        Launch
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  )
}
