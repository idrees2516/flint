// ─────────────────────────────────────────────────────────────
// Flint · Durable Actors — the two coordination atoms.
//
//   AgentActor (one per agent session, name = "agent:<sessionId>")
//     • durable session state: status, model, cost, turns, notes —
//       survives restarts, hibernation, node failover
//     • event-sourced mirror of the session's bus events
//     • durable wake-up alarms (survive crashes; at-least-once) —
//       powers heartbeats/continuation without a central cron
//     • kernel snapshot registry (any node can resume the kernel)
//     • direct A2A relay + space publishing (state shared across
//       agents through SpaceActor objects)
//
//   SpaceActor (shared named namespace, name = "space:<slug>")
//     • durable KV with last-writer-wins registers + versions
//     • pub/sub topics with persisted history + live watch
//     • handoff bundles: state + snapshot refs handed from one
//       agent to another with a single atomic call
//
// Modeled on the Cloudflare Agents SDK: each agent is a Durable
// Object; setState → onStateUpdate broadcast; schedule() →
// durable alarm; single-writer per actor.
// ─────────────────────────────────────────────────────────────
import { DurableObjectBase, durable, safeActorName } from './durable'
import { bus, type FlintEvent } from './events'
import { runTurn } from './rlm'

// events worth mirroring into the agent actor's event log
const MIRRORED_EVENTS = new Set<FlintEvent['type']>([
  'session:created', 'session:turn', 'session:turn-done', 'session:code', 'session:stdout',
  'session:compacted', 'session:error', 'a2a:sent', 'a2a:progress', 'goal:created',
  'goal:complete', 'goal:exhausted', 'autonomous:started', 'autonomous:done',
  'kernel:restarted', 'kernel:evicted', 'heartbeat:fired',
])

export interface AgentState {
  sessionId: string
  name: string
  status: string
  model: string
  parentSessionId?: string | null
  costUsd: number
  turns: number
  lastUserMessage?: string
  lastSummary?: string
  kernelSnapshotRef?: string
  tags?: string[]
}

export class AgentActor extends DurableObjectBase {
  static className = 'AgentActor'
  static rpcMethods = [
    'syncSession', 'stateSummary', 'publishState',
    'relay', 'broadcastToSpace', 'receive',
    'scheduleWakeUp', 'cancelWakeUp', 'wakeUpInfo',
    'registerKernelSnapshot', 'takeCheckpoint', 'restoreCheckpoint',
    'setNote', 'chatTail',
  ] as const

  get sessionId(): string { return this.name.replace(/^agent:/, '') }

  /** Pull latest session facts from the DB into durable state (output-gated). */
  async syncSession(): Promise<AgentState> {
    const { db } = await import('@/lib/db')
    const s = await db.agentSession.findUnique({
      where: { id: this.sessionId },
      include: { messages: { orderBy: { idx: 'desc' }, take: 1 } },
    })
    if (!s) {
      return (await this.stateSnapshot()) as unknown as AgentState
    }
    const last = s.messages.at(-1)
    await this.setState({
      sessionId: s.id,
      name: s.name,
      status: s.status,
      model: s.model,
      parentSessionId: s.parentId,
      costUsd: s.costUsd,
      turns: s.turnCount,
      compactCount: s.compactCount,
      tokensIn: s.tokensIn,
      tokensOut: s.tokensOut,
      lastKind: last?.kind ?? null,
      updatedAt: Date.now(),
    })
    return (await this.stateSnapshot()) as unknown as AgentState
  }

  async stateSummary(): Promise<Record<string, unknown>> {
    return this.stateSnapshot()
  }

  /** Agent-side state write (host fn `durable_state`). */
  async publishState(patch: Record<string, unknown>): Promise<number> {
    return this.setState({ ...patch, agentUpdatedAt: Date.now() })
  }

  async setNote(key: string, value: unknown): Promise<number> {
    const notes = ((await this.getState<Record<string, unknown>>('notes')) ?? {})
    notes[key] = value
    return this.setState({ notes: notes as unknown as Record<string, unknown> })
  }

  /** Direct A2A relay to another agent actor (nuclear-family checks stay in rlm). */
  async relay(toSessionId: string, payload: Record<string, unknown>): Promise<{ delivered: boolean; topicSeq: number }> {
    const stub = durable.stub<AgentActor>(safeActorName('agent', toSessionId))
    const evt = await this.appendEvent('relay-out', { to: toSessionId, payload }, 'a2a')
    void stub.receive({ from: this.sessionId, payload, at: Date.now() }).catch(() => {})
    const seq = await this.broadcastToSpace('flint-agents', 'a2a', { from: this.sessionId, to: toSessionId, payload })
    return { delivered: true, topicSeq: seq.seq }
  }

  /** Receive-side of A2A — durable inbox entry + event. */
  async receive(msg: { from: string; payload: unknown; at: number }): Promise<number> {
    const inbox = ((await this.getState<Array<Record<string, unknown>>>('inbox')) ?? [])
    inbox.unshift(msg)
    await this.putState('inbox', inbox.slice(0, 100))
    return (await this.appendEvent('relay-in', { from: msg.from, payload: msg.payload }, 'a2a')).seq
  }

  async broadcastToSpace(space: string, topic: string, payload: unknown): Promise<{ seq: number }> {
    const spaceStub = durable.stub<SpaceActor>(safeActorName('space', space))
    const evt = await spaceStub.publish(topic, payload, { from: this.name })
    return { seq: evt?.seq ?? 0 }
  }

  async chatTail(limit = 20): Promise<Array<Record<string, unknown>>> {
    const { db } = await import('@/lib/db')
    const msgs = await db.sessionMessage.findMany({
      where: { sessionId: this.sessionId },
      orderBy: { idx: 'desc' },
      take: Math.min(limit, 100),
    })
    return msgs.reverse().map((m) => ({ idx: m.idx, role: m.role, kind: m.kind, content: String(m.content).slice(0, 500) }))
  }

  // ── durable wake-ups (heartbeat / continuation without central cron) ──
  async scheduleWakeUp(input: { atMs?: number; delayMs?: number; prompt: string; mode?: 'turn' | 'note'; maxIterations?: number; cron?: string }): Promise<number> {
    const at = input.atMs ?? Date.now() + (input.delayMs ?? 60_000)
    await this.putState('wakeUp', {
      prompt: input.prompt,
      mode: input.mode ?? 'turn',
      maxIterations: input.maxIterations ?? 4,
      cron: input.cron ?? null,
    })
    await this.setAlarm(at)
    bus.emit({
      type: 'durable:alarm', source: 'agent',
      message: `wake-up scheduled on ${this.name} at ${new Date(at).toISOString()}${input.cron ? ` (cron ${input.cron})` : ''}`,
      refId: this.name,
      data: { at, cron: input.cron ?? null },
    })
    return at
  }

  async cancelWakeUp(): Promise<void> {
    await this.putState('wakeUp', null)
    await this.setAlarm(null)
  }

  async wakeUpInfo(): Promise<{ alarmAt: number | null; config: Record<string, unknown> | null }> {
    return { alarmAt: await this.getAlarm(), config: (await this.getState('wakeUp')) ?? null }
  }

  /** Idempotent alarm handler — fires the scheduled turn (at-least-once). */
  protected async alarm(scheduledTime: number): Promise<void> {
    const cfg = (await this.getState<{ prompt: string; mode: string; maxIterations: number; cron: string | null } | null>('wakeUp'))
    if (!cfg) return
    const s = await this.getState<AgentState | null>('__state') as unknown as AgentState | null
    const sessionStatus = s?.status
    if (cfg.mode !== 'note' && sessionStatus === 'running') {
      // don't stack turns on a busy session — retry in 60s (idempotent by design)
      durable.setAlarmEntry(this.name, Date.now() + 60_000)
      return
    }
    await this.appendEvent('wake-up', { scheduledTime, prompt: cfg.prompt.slice(0, 200), mode: cfg.mode }, 'alarm')
    if (cfg.mode === 'note') {
      await this.setState({ wakeNote: cfg.prompt, wakeNoteAt: scheduledTime })
    } else {
      // fire the turn asynchronously; alarm completes immediately (non-blocking)
      void runTurn(this.sessionId, cfg.prompt, { actor: 'durable-alarm', maxIterations: cfg.maxIterations ?? 4 }).catch(async (err) => {
        await this.appendEvent('wake-up-error', { error: String(err).slice(0, 500) }, 'alarm')
      })
    }
    if (cfg.cron) {
      const { nextFire } = await import('./heartbeats')
      try {
        const next = nextFire(cfg.cron, new Date(scheduledTime))
        await this.setAlarm(next.getTime())
      } catch {
        await this.putState('wakeUp', null)
      }
    } else {
      await this.putState('wakeUp', null)
    }
  }

  // ── kernel snapshot registry (mesh-addressable resume) ──
  async registerKernelSnapshot(blob: string, manifest: Record<string, unknown>): Promise<{ ref: string; version: number }> {
    const meta = await this.saveSnapshot('kernel', blob, manifest)
    await this.setState({ kernelSnapshotRef: meta.ref })
    return { ref: meta.ref, version: meta.version }
  }

  // ── state checkpoints (versioned, restorable) ──
  async takeCheckpoint(label = ''): Promise<{ ref: string; version: number }> {
    const state = await this.stateSnapshot()
    const kv = await this.listState()
    const meta = await this.saveSnapshot('state', JSON.stringify({ state, kv, label, at: Date.now() }), { label })
    return { ref: meta.ref, version: meta.version }
  }

  async restoreCheckpoint(ref?: string): Promise<{ restored: boolean; version?: number }> {
    const target = ref ? await this.loadSnapshot(ref) : await (async () => {
      const latest = await this.latestSnapshot('state')
      return latest ? await this.loadSnapshot(latest.ref) : null
    })()
    if (!target) return { restored: false }
    const parsed = JSON.parse(target.blob.toString('utf8')) as { state: Record<string, unknown>; kv: DurableKvPair[] }
    for (const row of parsed.kv ?? []) {
      if (!row.key.startsWith('__')) await this.putState(row.key, row.value)
    }
    await this.setState({ ...parsed.state, restoredFrom: target.meta.ref, restoredAt: Date.now() })
    return { restored: true, version: target.meta.version }
  }
}

interface DurableKvPair { key: string; value: unknown }

export interface SpaceKvEntry { key: string; value: unknown; version: number; updatedAt: number; updatedBy: string }

export class SpaceActor extends DurableObjectBase {
  static className = 'SpaceActor'
  static rpcMethods = [
    'kvGet', 'kvPut', 'kvDelete', 'kvList',
    'publish', 'history', 'info', 'handoff',
  ] as const

  get slug(): string { return this.name.replace(/^space:/, '') }

  /** LWW register write — version = monotonic counter + wall clock tiebreak. */
  async kvPut(key: string, value: unknown, updatedBy = 'api'): Promise<SpaceKvEntry> {
    const map = (await this.getState<Record<string, SpaceKvEntry>>('kv')) ?? {}
    const prev = map[key]
    const version = Math.max(prev?.version ?? 0, Date.now()) + (prev && prev.version >= Date.now() ? 1 : 0)
    const entry: SpaceKvEntry = { key, value, version, updatedAt: Date.now(), updatedBy }
    map[key] = entry
    await this.putState('kv', map)
    this.broadcast({ type: 'state', objectName: this.name, version, patch: { ['kv:' + key]: value }, state: map as unknown as Record<string, unknown>, ts: Date.now() })
    return entry
  }

  async kvGet(key: string): Promise<SpaceKvEntry | null> {
    const map = (await this.getState<Record<string, SpaceKvEntry>>('kv')) ?? {}
    return map[key] ?? null
  }

  async kvDelete(key: string): Promise<boolean> {
    const map = (await this.getState<Record<string, SpaceKvEntry>>('kv')) ?? {}
    const had = key in map
    delete map[key]
    await this.putState('kv', map)
    return had
  }

  async kvList(prefix?: string): Promise<SpaceKvEntry[]> {
    const map = (await this.getState<Record<string, SpaceKvEntry>>('kv')) ?? {}
    return Object.values(map)
      .filter((e) => !prefix || e.key.startsWith(prefix))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Pub/sub publish — persisted (event-sourced) + live fan-out. */
  async publish(topic: string, payload: unknown, meta: Record<string, unknown> = {}): Promise<{ seq: number; topic: string }> {
    const evt = await this.appendEvent(topic, { ...meta, payload }, 'publish')
    bus.emit({
      type: 'space:published', source: 'agent',
      message: `space ${this.slug} · ${topic} ← ${String((meta as { from?: string }).from ?? 'api').replace(/^agent:/, '')}`,
      refId: this.name,
      data: { topic, seq: evt.seq },
    })
    return { seq: evt.seq, topic }
  }

  async history(opts: { topic?: string; sinceSeq?: number; limit?: number } = {}): Promise<unknown[]> {
    return this.listEvents(opts) as unknown as unknown[]
  }

  async info(): Promise<Record<string, unknown>> {
    const kv = await this.kvList()
    const events = await this.listEvents({ limit: 1 })
    return {
      slug: this.slug,
      name: this.name,
      keys: kv.length,
      latestSeq: events[0]?.seq ?? 0,
      recentKeys: kv.slice(0, 10).map((e) => e.key),
      meta: this.meta(),
    }
  }

  /** Atomic agent-to-agent handoff: state bundle + snapshot refs move together. */
  async handoff(input: {
    fromAgent: string
    toAgent: string
    state: Record<string, unknown>
    snapshotRefs?: string[]
    note?: string
  }): Promise<{ seq: number }> {
    await this.kvPut(`handoff:${input.toAgent}`, {
      from: input.fromAgent,
      state: input.state,
      snapshotRefs: input.snapshotRefs ?? [],
      note: input.note ?? '',
      at: Date.now(),
    }, input.fromAgent)
    const evt = await this.publish('handoff', {
      from: input.fromAgent, to: input.toAgent,
      state: input.state, snapshotRefs: input.snapshotRefs ?? [], note: input.note ?? '',
    }, { from: input.fromAgent })
    // durable inbox for the receiving agent
    const stub = durable.stub<AgentActor>(safeActorName('agent', input.toAgent.replace(/^agent:/, '')))
    void stub.receive({ from: input.fromAgent, payload: { handoff: input.state, snapshotRefs: input.snapshotRefs, note: input.note }, at: Date.now() }).catch(() => {})
    return evt
  }
}

// ── boot + session-event mirroring ───────────────────────────

let mirrored = false

/** Register actor classes, boot the durable runtime, mirror session events. */
export function bootDurableActors(): void {
  durable.boot()
  durable.register(AgentActor)
  durable.register(SpaceActor)
  if (mirrored) return
  mirrored = true

  // fan bus events into per-agent durable event logs (throttled by kind)
  bus.on((e) => {
    if (!MIRRORED_EVENTS.has(e.type) || !e.refId) return
    const name = safeActorName('agent', e.refId)
    if (!e.refId || e.refId === 'agent-runtime') return
    const obj = durable.resolve(name, 'AgentActor')
    void obj.invoke('appendEvent', [e.type, { message: e.message, data: e.data, ts: e.ts }, 'bus'])
      .then(() => {
        // opportunistic light state sync on lifecycle transitions
        if (e.type === 'session:turn-done' || e.type === 'session:created' || e.type === 'session:error') {
          return durable.invoke(name, 'syncSession', [], 'AgentActor')
        }
        return undefined
      })
      .catch(() => {})
  })

  // ensure the default shared space exists
  void durable.invoke(safeActorName('space', 'flint-agents'), 'publish', ['boot', { online: true, at: Date.now() }, { from: 'system' }], 'SpaceActor').catch(() => {})
  console.log('[flint:durable] actors online — AgentActor + SpaceActor registered, bus mirroring active')
}

export function agentActor(sessionId: string) {
  return durable.stub<AgentActor>(safeActorName('agent', sessionId))
}
export function spaceActor(slug: string) {
  return durable.stub<SpaceActor>(safeActorName('space', slug))
}
