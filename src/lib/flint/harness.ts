// ─────────────────────────────────────────────────────────────
// Flint · Continual Harness — the self-improvement substrate.
//
// Four kinds of durable, agent-editable state (prime-agent parity):
//   memory        — long-lived facts the agent wants to recall
//   prompt_note   — supplemental system-prompt guidance
//   skill         — markdown skill docs (agentskills.io style)
//   subagent_spec — reusable subagent blueprints
//
// All edits flow through the refine pipeline: an evidence-backed
// planner proposes the smallest relevant edit, it is recorded as
// a Refinement (planned → applied), and any refinement can be
// rolled back. The base system prompt is immutable by design.
// ─────────────────────────────────────────────────────────────
import { db } from '@/lib/db'
import { bus } from './events'
import { DEFAULT_AUX_MODEL, findModel, modelCost } from './models'

export const HARNESS_KINDS = ['memory', 'prompt_note', 'skill', 'subagent_spec'] as const
export type HarnessKind = (typeof HARNESS_KINDS)[number]

export interface HarnessItemView {
  id: string
  kind: string
  name: string
  content: string
  scope: string
  tags: string
  useCount: number
  version: number
  enabled: boolean
  updatedAt: string
}

export function isHarnessKind(kind: string): kind is HarnessKind {
  return (HARNESS_KINDS as readonly string[]).includes(kind)
}

// ── CRUD ────────────────────────────────────────────────────
export async function upsertItem(input: {
  kind: string
  name: string
  content: string
  scope?: string
  sessionId?: string | null
  tags?: string
  actor?: string
}) {
  if (!isHarnessKind(input.kind)) throw new Error(`invalid harness kind "${input.kind}" — must be one of ${HARNESS_KINDS.join(', ')}`)
  const scope = input.scope === 'session' ? 'session' : 'global'
  const item = await db.harnessItem.upsert({
    where: { kind_name_scope: { kind: input.kind, name: input.name, scope } },
    create: {
      kind: input.kind,
      name: input.name,
      content: input.content,
      scope,
      sessionId: scope === 'session' ? (input.sessionId ?? null) : null,
      tags: input.tags ?? '',
    },
    update: { content: input.content, tags: input.tags ?? undefined },
  })
  bus.emit({
    type: 'harness:updated',
    source: 'agent',
    message: `${input.actor ?? 'harness'} · ${input.kind} "${input.name}" saved (v${item.version})`,
    refId: item.id,
  })
  return item
}

export async function deleteItem(id: string) {
  await db.harnessItem.delete({ where: { id } }).catch(() => null)
  bus.emit({ type: 'harness:updated', source: 'agent', message: `harness item ${id.slice(-6)} deleted` })
}

export async function listItems(kind?: string, scope?: string): Promise<HarnessItemView[]> {
  const items = await db.harnessItem.findMany({
    where: {
      ...(kind ? { kind } : {}),
      ...(scope ? { scope } : {}),
      enabled: true,
    },
    orderBy: [{ kind: 'asc' }, { name: 'asc' }],
  })
  return items.map((i) => ({
    id: i.id,
    kind: i.kind,
    name: i.name,
    content: i.content,
    scope: i.scope,
    tags: i.tags,
    useCount: i.useCount,
    version: i.version,
    enabled: i.enabled,
    updatedAt: i.updatedAt.toISOString(),
  }))
}

export async function getItem(kind: string, name: string) {
  return db.harnessItem.findFirst({ where: { kind, name } })
}

export async function bumpUse(id: string) {
  await db.harnessItem.update({ where: { id }, data: { useCount: { increment: 1 } } }).catch(() => null)
}

export async function searchHarness(query: string): Promise<HarnessItemView[]> {
  const q = query.trim().toLowerCase()
  if (!q) return listItems()
  const all = await listItems()
  return all.filter(
    (i) => i.name.toLowerCase().includes(q) || i.content.toLowerCase().includes(q) || i.tags.toLowerCase().includes(q)
  )
}

/** Harness blocks injected into the system prompt (memories + notes + skills inventory). */
export async function harnessPromptBlocks(sessionId?: string): Promise<string> {
  const items = await db.harnessItem.findMany({ where: { enabled: true }, orderBy: [{ kind: 'asc' }, { name: 'asc' }] })
  const inScope = items.filter((i) => i.scope === 'global' || (sessionId && i.scope === 'session' && i.sessionId === sessionId))
  const sections: string[] = []
  const memories = inScope.filter((i) => i.kind === 'memory')
  if (memories.length) {
    sections.push('MEMORIES (durable facts — refine via harness CRUD):\n' + memories.map((m) => `- ${m.name}: ${m.content.slice(0, 300)}`).join('\n'))
  }
  const notes = inScope.filter((i) => i.kind === 'prompt_note')
  if (notes.length) {
    sections.push('SUPPLEMENTAL PROMPT NOTES:\n' + notes.map((n) => `- ${n.name}: ${n.content.slice(0, 300)}`).join('\n'))
  }
  const skills = inScope.filter((i) => i.kind === 'skill')
  if (skills.length) {
    sections.push(
      'AVAILABLE SKILLS (invoke by writing a plan that follows the skill doc):\n' +
        skills.map((s) => `- ${s.name}: ${s.content.split('\n')[0].slice(0, 200)}`).join('\n')
    )
  }
  const specs = inScope.filter((i) => i.kind === 'subagent_spec')
  if (specs.length) {
    sections.push('SUBAGENT SPECS (spawn with host("spawn", name, prompt)):\n' + specs.map((s) => `- ${s.name}: ${s.content.split('\n')[0].slice(0, 200)}`).join('\n'))
  }
  return sections.join('\n\n')
}

// ── refine pipeline ─────────────────────────────────────────
interface AuxZaiClient {
  chat: {
    completions: {
      create: (args: Record<string, unknown>) => Promise<{ choices: Array<{ message?: { content?: string } }> }>
    }
  }
}

async function auxChat(system: string, user: string): Promise<string> {
  const ZAI = (await import('z-ai-web-dev-sdk')).default
  const g = globalThis as unknown as { __zai?: AuxZaiClient }
  const z = g.__zai ?? ((g.__zai = (await ZAI.create()) as unknown as AuxZaiClient))
  const completion = await z.chat.completions.create({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    thinking: { type: 'disabled' },
    max_tokens: 900,
    temperature: 0.1,
  })
  return (completion.choices[0]?.message?.content ?? '').trim()
}

export interface PlannedRefinement {
  itemId: string
  itemName: string
  kind: string
  reason: string
  after: string
  before: string
}

/**
 * Plan refinements: the planner LLM reviews harness items against
 * recent evidence and proposes the SMALLEST relevant edits.
 * Returns planned (not yet applied) Refinements.
 */
export async function planRefinements(evidence: string, opts: { sessionId?: string; maxEdits?: number } = {}): Promise<PlannedRefinement[]> {
  const items = await db.harnessItem.findMany({ where: { enabled: true } })
  if (items.length === 0) return []
  const catalog = items.map((i) => `# ${i.kind}/${i.name} (v${i.version})\n${i.content.slice(0, 1200)}`).join('\n\n')
  const raw = await auxChat(
    `You are the Flint harness refinement planner. Given the harness items and recent session evidence, propose the SMALLEST set of edits that would improve the agent. Only propose an edit when evidence justifies it. Respond ONLY with JSON:
{"refinements":[{"kind":"memory|prompt_note|skill|subagent_spec","name":"<existing item name>","reason":"<evidence-backed reason>","after":"<full new content>"}], "new_items":[{"kind":"...","name":"<new name>","reason":"...","content":"..."}]}
Max ${opts.maxEdits ?? 3} edits. If nothing is worth changing, return {"refinements":[],"new_items":[]}.`,
    `HARNESS ITEMS:\n${catalog}\n\nRECENT EVIDENCE:\n${evidence.slice(0, 6000)}`
  )
  let parsed: { refinements?: Array<{ kind: string; name: string; reason: string; after: string }>; new_items?: Array<{ kind: string; name: string; reason: string; content: string }> }
  try {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return []
  }
  const planned: PlannedRefinement[] = []
  for (const r of (parsed.refinements ?? []).slice(0, opts.maxEdits ?? 3)) {
    const item = items.find((i) => i.kind === r.kind && i.name === r.name)
    if (!item || item.content === r.after) continue
    const ref = await db.refinement.create({
      data: { itemId: item.id, reason: r.reason.slice(0, 500), before: item.content, after: r.after, status: 'planned', plannerModel: DEFAULT_AUX_MODEL },
    })
    planned.push({ itemId: item.id, itemName: item.name, kind: item.kind, reason: r.reason, after: r.after, before: item.content })
    bus.emit({
      type: 'harness:refine',
      source: 'agent',
      level: 'info',
      message: `refinement planned: ${item.kind}/${item.name} — ${r.reason.slice(0, 120)}`,
      refId: ref.id,
    })
  }
  // new items are created directly (they are additive, not edits)
  for (const n of (parsed.new_items ?? []).slice(0, opts.maxEdits ?? 3)) {
    if (!isHarnessKind(n.kind) || !n.name || !n.content) continue
    await upsertItem({ kind: n.kind, name: n.name, content: n.content, actor: 'refine-planner', tags: 'auto' })
  }
  return planned
}

/** Apply a planned refinement (bump version, keep rollback record). */
export async function applyRefinement(refinementId: string) {
  const ref = await db.refinement.findUnique({ where: { id: refinementId }, include: { item: true } })
  if (!ref || ref.status !== 'planned') throw new Error('refinement not in planned state')
  await db.harnessItem.update({
    where: { id: ref.itemId },
    data: { content: ref.after, version: { increment: 1 } },
  })
  await db.refinement.update({ where: { id: refinementId }, data: { status: 'applied', appliedAt: new Date() } })
  bus.emit({
    type: 'harness:refine',
    source: 'agent',
    level: 'success',
    message: `refinement applied: ${ref.item.kind}/${ref.item.name} → v${ref.item.version + 1}`,
    refId: ref.itemId,
  })
}

/** Roll back an applied refinement. */
export async function rollbackRefinement(refinementId: string) {
  const ref = await db.refinement.findUnique({ where: { id: refinementId }, include: { item: true } })
  if (!ref) throw new Error('refinement not found')
  await db.harnessItem.update({ where: { id: ref.itemId }, data: { content: ref.before } })
  await db.refinement.update({ where: { id: refinementId }, data: { status: 'rolled-back' } })
  bus.emit({
    type: 'harness:refine',
    source: 'agent',
    level: 'warn',
    message: `refinement rolled back: ${ref.item.kind}/${ref.item.name}`,
    refId: ref.itemId,
  })
}

export async function refinementHistory(itemId?: string) {
  return db.refinement.findMany({
    where: itemId ? { itemId } : {},
    include: { item: { select: { kind: true, name: true, version: true } } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
}

/** Account a refine-planner call (cost transparency). */
export function accountAuxCost(modelId: string, inText: string, outText: string): number {
  const tokensIn = Math.ceil(inText.length / 3.6)
  const tokensOut = Math.ceil(outText.length / 3.6)
  return modelCost(modelId ?? DEFAULT_AUX_MODEL, tokensIn, tokensOut)
}

export function auxModelName(): string {
  return findModel(DEFAULT_AUX_MODEL).name
}
