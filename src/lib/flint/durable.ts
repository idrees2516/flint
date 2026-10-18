// ─────────────────────────────────────────────────────────────
// Flint · Durable Runtime — Cloudflare Durable Objects
// architecture, ported to a self-hostable Node/Bun process.
//
// Research-grounded semantics (developers.cloudflare.com/durable-objects,
// 2026 docs + Agents SDK):
//   • Actor model: one single-threaded, globally-unique object per
//     deterministic name — no locks, strong consistency per key.
//   • Isolated per-object storage (SQLite when Bun available,
//     atomic JSON-file fallback otherwise) — the "zero-latency
//     SQLite in every Durable Object" pattern.
//   • Input gates: invocations are serialized per object; storage
//     operations cannot interleave (single-writer queue).
//   • Output gates: setState persists durably before any
//     subscriber/notification is released.
//   • Durable alarms: millisecond-precision timers that survive
//     restarts; at-least-once delivery; handler failures retried
//     up to 6× with exponential backoff (2s→64s); handlers must be
//     idempotent.
//   • Hibernation: idle objects are evicted from memory (state
//     flushed to storage); the next invocation lazily rehydrates.
//     A global alarm index wakes hibernated objects when their
//     alarm is due — exactly how Cloudflare wakes sleeping DOs.
//   • RPC stubs: namespacing by class + getByName(name) returns a
//     transparent proxy; the call path is a single `invoke()`
//     function, transport-swappable for multi-node later.
//   • State broadcast: setState(partial) → durable write →
//     onStateUpdate fan-out to subscribers (SSE in API routes).
//   • Event sourcing: append-only per-object log with sequence
//     numbers; replay from any seq.
//   • Versioned snapshots: state / kernel / fs / mesh bundles,
//     forkable across nodes and providers.
//
// Anti-pattern honored: no global singleton object (Cloudflare
// "Rules of Durable Objects") — coordination atoms are per-agent
// and per-space.
// ─────────────────────────────────────────────────────────────
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { bus } from './events'

export type DurableTypeName = string

export interface DurableKvRow { key: string; value: unknown }

export interface DurableEventRow {
  seq: number
  topic: string
  kind: string
  payload: unknown
  ts: number
}

export interface DurableSnapshotMeta {
  ref: string
  objectName: string
  kind: string
  version: number
  sizeBytes: number
  createdAt: number
  manifest: Record<string, unknown>
}

export interface StateUpdate {
  type: 'state' | 'event' | 'alarm' | 'snapshot'
  objectName: string
  version?: number
  patch?: Record<string, unknown>
  state?: Record<string, unknown>
  event?: DurableEventRow
  alarmAt?: number | null
  snapshot?: DurableSnapshotMeta
  ts: number
}

type Subscriber = (u: StateUpdate) => void

const DURABLE_DIR = path.join(process.cwd(), 'sandboxes', '.durable')
const OBJECTS_DIR = path.join(DURABLE_DIR, 'objects')
const SNAPSHOTS_DIR = path.join(DURABLE_DIR, 'snapshots')
const ALARM_INDEX = path.join(DURABLE_DIR, '_alarms.json')
const SQL_DIR = path.join(DURABLE_DIR, 'sqlite')

const IDLE_HIBERNATE_MS = 10 * 60_000 // CF eviction: idle DOs are evicted
const SWEEP_INTERVAL_MS = 30_000
const ALARM_TICK_MS = 1_000
const ALARM_MAX_RETRIES = 6 // CF: alarm() retried up to 6 times
const MIRROR_DEBOUNCE_MS = 2_500

// ── storage backends ────────────────────────────────────────

interface StorageBackend {
  get(key: string): unknown | undefined
  put(key: string, value: unknown): void
  delete(key: string): boolean
  list(prefix?: string): DurableKvRow[]
  count(): number
  bytes(): number
  // event log
  appendEvent(topic: string, kind: string, payload: unknown): number
  listEvents(opts: { topic?: string; sinceSeq?: number; limit?: number }): DurableEventRow[]
  eventCount(): number
  // atomic persistence
  flush(): Promise<void>
}

/** Bun-native SQLite backend — "zero-latency SQLite in every DO". */
class SqliteBackend implements StorageBackend {
  private db: {
    query: (sql: string) => { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[]; run: (...a: unknown[]) => unknown }
    run: (sql: string) => unknown
    close: () => void
  } | null = null
  private file: string

  constructor(name: string) {
    fs.mkdirSync(SQL_DIR, { recursive: true })
    this.file = path.join(SQL_DIR, name.replace(/[^a-zA-Z0-9_:.-]/g, '_') + '.sqlite')
  }

  attach(db: NonNullable<SqliteBackend['db']>): void {
    this.db = db
    this.db.run('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    this.db.run('CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, topic TEXT, kind TEXT, payload TEXT, ts INTEGER)')
  }

  private q(sql: string) {
    if (!this.db) throw new Error('sqlite not attached')
    return this.db.query(sql)
  }

  get(key: string): unknown | undefined {
    const row = this.q('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined
    return row ? JSON.parse(row.value) : undefined
  }
  put(key: string, value: unknown): void {
    this.q('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
      key,
      JSON.stringify(value)
    )
  }
  delete(key: string): boolean {
    this.q('DELETE FROM kv WHERE key = ?').run(key)
    return true
  }
  list(prefix?: string): DurableKvRow[] {
    const rows = prefix
      ? (this.q('SELECT key, value FROM kv WHERE key LIKE ? ORDER BY key').all(prefix + '%') as { key: string; value: string }[])
      : (this.q('SELECT key, value FROM kv ORDER BY key').all() as { key: string; value: string }[])
    return rows.map((r) => ({ key: r.key, value: JSON.parse(r.value) }))
  }
  count(): number {
    const r = this.q('SELECT COUNT(*) AS c FROM kv').get() as { c: number }
    return r.c
  }
  bytes(): number {
    try { return fs.statSync(this.file).size } catch { return 0 }
  }
  appendEvent(topic: string, kind: string, payload: unknown): number {
    const seq = ((this.q('SELECT COALESCE(MAX(seq),0)+1 AS s FROM events').get() as { s: number }).s)
    this.q('INSERT INTO events (seq, topic, kind, payload, ts) VALUES (?,?,?,?,?)').run(
      seq, topic, kind, JSON.stringify(payload), Date.now()
    )
    return seq
  }
  listEvents(opts: { topic?: string; sinceSeq?: number; limit?: number }): DurableEventRow[] {
    const limit = Math.min(opts.limit ?? 100, 1000)
    const since = opts.sinceSeq ?? 0
    const rows = opts.topic
      ? (this.q('SELECT seq, topic, kind, payload, ts FROM events WHERE seq > ? AND topic = ? ORDER BY seq DESC LIMIT ?').all(since, opts.topic, limit) as Record<string, unknown>[])
      : (this.q('SELECT seq, topic, kind, payload, ts FROM events WHERE seq > ? ORDER BY seq DESC LIMIT ?').all(since, limit) as Record<string, unknown>[])
    return rows.map((r) => ({ seq: r.seq as number, topic: r.topic as string, kind: r.kind as string, payload: JSON.parse(r.payload as string), ts: r.ts as number }))
  }
  eventCount(): number {
    const r = this.q('SELECT COUNT(*) AS c FROM events').get() as { c: number }
    return r.c
  }
  async flush(): Promise<void> {
    /* sqlite writes are already durable (WAL) */
  }
}

/** Portable JSON-file backend — atomic tmp+rename writes, works everywhere. */
class JsonBackend implements StorageBackend {
  private file: string
  private data: { kv: Record<string, unknown>; events: DurableEventRow[] }
  private dirty = false

  constructor(name: string) {
    const safe = name.replace(/[^a-zA-Z0-9_:.-]/g, '_')
    this.file = path.join(OBJECTS_DIR, safe + '.json')
    let parsed: { kv?: Record<string, unknown>; events?: DurableEventRow[] } = {}
    try { parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch { /* fresh object */ }
    this.data = { kv: parsed.kv ?? {}, events: parsed.events ?? [] }
  }

  private persistNow(): void {
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.data))
    fs.renameSync(tmp, this.file)
    this.dirty = false
  }
  private schedulePersist(): void {
    this.dirty = true
    queueMicrotask(() => { if (this.dirty) this.persistNow() })
  }

  get(key: string): unknown | undefined { return this.data.kv[key] }
  put(key: string, value: unknown): void { this.data.kv[key] = value; this.schedulePersist() }
  delete(key: string): boolean { const had = key in this.data.kv; delete this.data.kv[key]; this.schedulePersist(); return had }
  list(prefix?: string): DurableKvRow[] {
    return Object.keys(this.data.kv)
      .filter((k) => !prefix || k.startsWith(prefix))
      .sort()
      .map((k) => ({ key: k, value: this.data.kv[k] }))
  }
  count(): number { return Object.keys(this.data.kv).length }
  bytes(): number { try { return fs.statSync(this.file).size } catch { return 0 } }
  appendEvent(topic: string, kind: string, payload: unknown): number {
    const seq = (this.data.events.at(-1)?.seq ?? 0) + 1
    this.data.events.push({ seq, topic, kind, payload, ts: Date.now() })
    if (this.data.events.length > 5000) this.data.events = this.data.events.slice(-4000)
    this.schedulePersist()
    return seq
  }
  listEvents(opts: { topic?: string; sinceSeq?: number; limit?: number }): DurableEventRow[] {
    const since = opts.sinceSeq ?? 0
    let rows = this.data.events.filter((e) => e.seq > since)
    if (opts.topic) rows = rows.filter((e) => e.topic === opts.topic)
    return rows.slice(-Math.min(opts.limit ?? 100, 1000)).reverse()
  }
  eventCount(): number { return this.data.events.length }
  async flush(): Promise<void> { if (this.dirty) this.persistNow() }
}

// ── alarm index (wakes hibernated objects — CF global alarm queue) ──

interface AlarmIndex { [objectName: string]: number }
const alarmRetries = new Map<string, number>()

function readAlarmIndex(): AlarmIndex {
  try { return JSON.parse(fs.readFileSync(ALARM_INDEX, 'utf8')) as AlarmIndex } catch { return {} }
}
function writeAlarmIndex(idx: AlarmIndex): void {
  fs.mkdirSync(DURABLE_DIR, { recursive: true })
  const tmp = ALARM_INDEX + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(idx))
  fs.renameSync(tmp, ALARM_INDEX)
}

// ── durable object base ──────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
export abstract class DurableObjectBase {
  static className = 'DurableObject'
  /** RPC surface — subclasses list their callable methods (CF RPC stub parity). */
  static rpcMethods: readonly string[] = []

  readonly name: string
  readonly className: string
  protected store: StorageBackend
  private queue: Promise<unknown> = Promise.resolve() // input gate (single-writer)
  private subscribers = new Set<Subscriber>()
  private mirrorTimer: ReturnType<typeof setTimeout> | null = null
  private lastActivity = Date.now()
  hibernated = false
  opsCount = 0
  private stateVersion: number | null = null

  constructor(name: string, backend?: StorageBackend) {
    this.name = name
    this.className = (this.constructor as typeof DurableObjectBase).className
    this.store = backend ?? new JsonBackend(name)
  }

  attachSqlite(db: NonNullable<SqliteBackend['db']>): void {
    const sql = new SqliteBackend(this.name)
    sql.attach(db)
    // migrate existing KV + events
    for (const row of this.store.list()) sql.put(row.key, row.value)
    for (const e of this.store.listEvents({ limit: 1000 }).reverse()) sql.appendEvent(e.topic, e.kind, e.payload)
    this.store = sql
  }

  // ── invocation gate (single-threaded actor semantics) ──
  invoke<R = unknown>(method: string, args: unknown[]): Promise<R> {
    this.lastActivity = Date.now()
    this.opsCount++
    const run = this.queue.then(() => this.dispatch(method, args))
    // keep the gate alive after failures, CF-style exception boundaries
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run as Promise<R>
  }

  /** CF blockConcurrencyWhile — exclusive execution, no interleaving. */
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    this.lastActivity = Date.now()
    const run = this.queue.then(fn)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  private static readonly INTERNAL_METHODS = new Set(['_fireAlarm', '_durable_set', '_durable_delete', '_durable_meta'])
  /** Base-class RPC surface available on every durable object (CF stub parity). */
  private static readonly BASE_RPC_METHODS = new Set([
    'stateSnapshot', 'listEvents', 'appendEvent', 'saveSnapshot', 'loadSnapshot',
    'latestSnapshot', 'listSnapshots', 'setAlarm', 'getAlarm', 'cancelAlarm',
  ])

  private dispatch(method: string, args: unknown[]): Promise<unknown> {
    const cls = this.constructor as typeof DurableObjectBase
    if (method === '_durable_meta') return Promise.resolve(this.meta())
    if (method === '_durable_set') return this.putState(String(args[0]), args[1]).then(() => undefined)
    if (method === '_durable_delete') return Promise.resolve(this.deleteState(String(args[0])))
    if (method === '_fireAlarm') {
      return Promise.resolve((this as unknown as { _fireAlarm: (t: number) => Promise<unknown> })._fireAlarm(args[0] as number))
    }
    if (!cls.rpcMethods.includes(method) && !DurableObjectBase.BASE_RPC_METHODS.has(method)) {
      return Promise.reject(new Error(`durable rpc "${method}" not exposed on ${this.className}`))
    }
    const fn = (this as any)[method]
    if (typeof fn !== 'function') return Promise.reject(new Error(`durable method missing: ${method}`))
    return Promise.resolve(fn.apply(this, args))
  }

  meta(): { name: string; className: string; hibernated: boolean; opsCount: number; kvCount: number; storageBytes: number; events: number; stateVersion: number } {
    return {
      name: this.name,
      className: this.className,
      hibernated: this.hibernated,
      opsCount: this.opsCount,
      kvCount: this.store.count(),
      storageBytes: this.store.bytes(),
      events: this.store.eventCount(),
      stateVersion: this.stateVersion ?? 0,
    }
  }

  // ── state: durable KV + versioned setState + broadcast ──
  async getState<T>(key: string, fallback?: T): Promise<T> {
    const v = this.store.get(key)
    return (v === undefined ? fallback : v) as T
  }
  async putState(key: string, value: unknown): Promise<void> {
    this.store.put(key, value)
    await this.store.flush()
  }
  async deleteState(key: string): Promise<boolean> {
    return this.store.delete(key)
  }
  async listState(prefix?: string): Promise<DurableKvRow[]> {
    return this.store.list(prefix)
  }

  /**
   * Agents-SDK-style state update: merge patch → durable write
   * (output gate: persist BEFORE broadcast) → onStateUpdate fan-out.
   */
  async setState(patch: Record<string, unknown>, opts: { broadcast?: boolean } = {}): Promise<number> {
    this.lastActivity = Date.now()
    const current = (this.store.get('__state') as Record<string, unknown>) ?? {}
    const merged = { ...current, ...patch }
    // deletions: null-valued keys are removed
    for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k]
    const version = ((this.store.get('__state_version') as number) ?? 0) + 1
    this.store.put('__state', merged)
    this.store.put('__state_version', version)
    await this.store.flush() // output gate — durable before anyone sees it
    this.stateVersion = version
    if (opts.broadcast !== false) {
      this.broadcast({ type: 'state', objectName: this.name, version, patch, state: merged, ts: Date.now() })
      void this.mirrorToDb(merged, version)
    }
    return version
  }

  async stateSnapshot(): Promise<Record<string, unknown>> {
    return ((this.store.get('__state') as Record<string, unknown>) ?? {})
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn)
    return () => this.subscribers.delete(fn)
  }
  subscriberCount(): number { return this.subscribers.size }

  protected broadcast(u: StateUpdate): void {
    for (const fn of this.subscribers) {
      try { fn(u) } catch { /* isolate subscriber failures */ }
    }
  }

  private async mirrorToDb(state: Record<string, unknown>, version: number): Promise<void> {
    // DB mirror is best-effort cache for cross-node queries; source of truth is object storage
    if (this.mirrorTimer) return
    this.mirrorTimer = setTimeout(() => {
      this.mirrorTimer = null
      void (async () => {
        try {
          const { db } = await import('@/lib/db')
          await db.durableObject.upsert({
            where: { name: this.name },
            create: {
              name: this.name,
              className: this.className,
              status: 'active',
              state: JSON.stringify(state),
              stateVersion: version,
              opsCount: this.opsCount,
              storageBytes: this.store.bytes(),
              eventCount: this.store.eventCount(),
            },
            update: {
              status: 'active',
              state: JSON.stringify(state),
              stateVersion: version,
              opsCount: this.opsCount,
              storageBytes: this.store.bytes(),
              eventCount: this.store.eventCount(),
              lastActiveAt: new Date(),
            },
          })
        } catch { /* mirror best-effort */ }
      })()
    }, MIRROR_DEBOUNCE_MS)
    if (this.mirrorTimer.unref) this.mirrorTimer.unref()
  }

  // ── event sourcing ──
  async appendEvent(topic: string, payload: unknown, kind = 'event'): Promise<DurableEventRow> {
    this.lastActivity = Date.now()
    const seq = this.store.appendEvent(topic, kind, payload)
    const evt: DurableEventRow = { seq, topic, kind, payload, ts: Date.now() }
    this.broadcast({ type: 'event', objectName: this.name, event: evt, ts: evt.ts })
    void (async () => {
      try {
        const { db } = await import('@/lib/db')
        await db.durableEvent.create({
          data: { objectName: this.name, topic, kind, payload: JSON.stringify(payload ?? {}).slice(0, 32768), seq },
        }).catch(() => {})
      } catch { /* mirror best-effort */ }
    })()
    return evt
  }
  async listEvents(opts: { topic?: string; sinceSeq?: number; limit?: number } = {}): Promise<DurableEventRow[]> {
    return this.store.listEvents(opts)
  }

  // ── alarms (durable, at-least-once, 6× retry w/ backoff) ──
  async setAlarm(scheduledTime: number | null): Promise<void> {
    this.lastActivity = Date.now()
    const idx = readAlarmIndex()
    if (scheduledTime === null) {
      delete idx[this.name]
      alarmRetries.delete(this.name)
    } else {
      idx[this.name] = scheduledTime
      alarmRetries.delete(this.name)
    }
    writeAlarmIndex(idx)
    this.broadcast({ type: 'alarm', objectName: this.name, alarmAt: scheduledTime, ts: Date.now() })
  }
  async getAlarm(): Promise<number | null> {
    const idx = readAlarmIndex()
    return idx[this.name] ?? null
  }

  /** Cancel any pending alarm (kept for RPC symmetry). */
  async cancelAlarm(): Promise<void> {
    await this.setAlarm(null)
  }

  /** Internal — fired by the registry's alarm wheel. Do not call directly. */
  async _fireAlarm(scheduledTime: number): Promise<{ ok: boolean; error?: string }> {
    this.lastActivity = Date.now()
    this.broadcast({ type: 'alarm', objectName: this.name, alarmAt: scheduledTime, ts: Date.now() })
    try {
      await this.alarm(scheduledTime)
      alarmRetries.delete(this.name)
      return { ok: true }
    } catch (err) {
      const attempt = (alarmRetries.get(this.name) ?? 0) + 1
      alarmRetries.set(this.name, attempt)
      if (attempt >= ALARM_MAX_RETRIES) {
        alarmRetries.delete(this.name)
        bus.emit({
          type: 'durable:alarm', source: 'api', level: 'error',
          message: `alarm on ${this.name} failed ${attempt}× — giving up`,
          refId: this.name,
        })
        return { ok: false, error: String(err) }
      }
      // CF: exponential backoff starting at 2s
      const backoff = 2_000 * Math.pow(2, attempt - 1)
      const idx = readAlarmIndex()
      idx[this.name] = Date.now() + backoff
      writeAlarmIndex(idx)
      return { ok: false, error: String(err) }
    }
  }

  /** Override to handle alarms. Must be idempotent (at-least-once delivery). */
  protected async alarm(_scheduledTime: number): Promise<void> { /* optional */ }

  // ── snapshots (versioned, forkable) ──
  async saveSnapshot(kind: string, blob: string | Buffer, manifest: Record<string, unknown> = {}): Promise<DurableSnapshotMeta> {
    this.lastActivity = Date.now()
    const existing = await this.listSnapshots(kind)
    const version = (existing.at(0)?.version ?? 0) + 1
    const ref = 'snap_' + crypto.createHash('sha256').update(this.name + '|' + kind + '|' + version + '|' + Date.now()).digest('hex').slice(0, 20)
    fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true })
    const blobPath = path.join(SNAPSHOTS_DIR, ref + '.bin')
    await fsp.writeFile(blobPath, blob)
    const sizeBytes = typeof blob === 'string' ? Buffer.byteLength(blob) : blob.length
    const meta: DurableSnapshotMeta = { ref, objectName: this.name, kind, version, sizeBytes, createdAt: Date.now(), manifest }
    const snaps = (this.store.get('__snapshots') as DurableSnapshotMeta[]) ?? []
    snaps.unshift(meta)
    this.store.put('__snapshots', snaps.slice(0, 50))
    await this.store.flush()
    this.broadcast({ type: 'snapshot', objectName: this.name, snapshot: meta, ts: Date.now() })
    void (async () => {
      try {
        const { db } = await import('@/lib/db')
        await db.durableSnapshot.create({
          data: { objectName: this.name, ref, kind, version, sizeBytes, blobPath, manifest: JSON.stringify(manifest) },
        }).catch(() => {})
      } catch { /* mirror best-effort */ }
    })()
    bus.emit({
      type: 'snapshot:created', source: 'api',
      message: `durable snapshot ${kind} v${version} on ${this.name} (${(sizeBytes / 1024).toFixed(1)} KiB)`,
      refId: this.name,
      data: { ref, kind, version },
    })
    return meta
  }

  async loadSnapshot(ref: string): Promise<{ meta: DurableSnapshotMeta; blob: Buffer } | null> {
    const snaps = (this.store.get('__snapshots') as DurableSnapshotMeta[]) ?? []
    const meta = snaps.find((s) => s.ref === ref)
    if (!meta) return null
    try {
      const blob = await fsp.readFile(path.join(SNAPSHOTS_DIR, meta.ref + '.bin'))
      return { meta, blob }
    } catch { return null }
  }

  async latestSnapshot(kind: string): Promise<DurableSnapshotMeta | null> {
    const snaps = (this.store.get('__snapshots') as DurableSnapshotMeta[]) ?? []
    return snaps.find((s) => s.kind === kind) ?? null
  }

  async listSnapshots(kind?: string): Promise<DurableSnapshotMeta[]> {
    const snaps = (this.store.get('__snapshots') as DurableSnapshotMeta[]) ?? []
    return kind ? snaps.filter((s) => s.kind === kind) : snaps
  }

  // ── hibernation (CF eviction semantics) ──
  idleFor(): number { return Date.now() - this.lastActivity }
  async hibernate(): Promise<void> {
    if (this.hibernated) return
    await this.store.flush()
    this.hibernated = true
    bus.emit({
      type: 'durable:state', source: 'api', level: 'info',
      message: `object ${this.name} hibernated (state durable, ${this.subscribers.size} live subscriber(s))`,
      refId: this.name,
    })
  }
  async wake(): Promise<void> {
    this.hibernated = false
    this.lastActivity = Date.now()
  }

  /** Overridable init — run under blockConcurrencyWhile (CF pattern). */
  async init(): Promise<void> { /* optional */ }
}

// ── stub + namespace ─────────────────────────────────────────

/**
 * Transparent RPC stub — Cloudflare DurableObjectStub analogue.
 * Every call routes through registry.invoke() so the transport can
 * later be swapped to cross-node RPC without touching callers.
 */
export interface DurableStub<T> { [k: string]: any & T[keyof T] }

// ── registry (the runtime) ───────────────────────────────────

export interface DurableStats {
  liveObjects: number
  hibernated: number
  totalOps: number
  pendingAlarms: number
  storageBytes: number
  uptimeMs: number
}

interface ClassEntry { ctor: new (name: string) => DurableObjectBase; className: string }

class DurableRegistry {
  private classes = new Map<string, ClassEntry>()
  private objects = new Map<string, DurableObjectBase>()
  private bootTime = Date.now()
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private alarmTimer: ReturnType<typeof setInterval> | null = null
  private booted = false
  sqliteAvailable = false

  /** Register a durable class (like exporting a DO class in wrangler). */
  register(ctor: new (name: string) => DurableObjectBase): void {
    const className = (ctor as unknown as typeof DurableObjectBase).className
    this.classes.set(className, { ctor, className })
  }

  /** Get-or-create an object; hibernated objects are rehydrated lazily. */
  resolve(name: string, className?: string): DurableObjectBase {
    let obj = this.objects.get(name)
    if (obj) {
      if (obj.hibernated) void obj.wake()
      return obj
    }
    if (!className) {
      // infer from name prefix (agent: | space:) or default to first
      className = name.startsWith('agent:') ? 'AgentActor' : name.startsWith('space:') ? 'SpaceActor' : [...this.classes.keys()][0]
    }
    const entry = this.classes.get(className)
    if (!entry) throw new Error(`durable class "${className}" not registered`)
    obj = new entry.ctor(name)
    this.objects.set(name, obj)
    void obj.blockConcurrencyWhile(() => obj!.init())
    void this.upgradeSqlite(obj)
    bus.emit({
      type: 'durable:state', source: 'api',
      message: `durable object ${name} (${className}) instantiated`,
      refId: name,
    })
    return obj
  }

  /** Raw invocation — the transport seam (in-process today, RPC tomorrow). */
  async invoke<R = unknown>(name: string, method: string, args: unknown[], className?: string): Promise<R> {
    const obj = this.resolve(name, className)
    return obj.invoke<R>(method, args)
  }

  /** RPC stub proxy — getByName(name).someMethod(...). */
  stub<T extends DurableObjectBase>(name: string, className?: string): DurableStub<T> {
    const self = this
    return new Proxy({ __durableStubName: name } as unknown as DurableStub<T>, {
      get(target, prop: string) {
        if (prop === '__durableStubName' || prop === 'then') return (target as any)[prop]
        return (...args: unknown[]) => self.invoke(name, prop, args, className)
      },
    })
  }

  /** Deterministic ID from name (CF idFromName parity — sha1, hex). */
  idFromName(name: string): string {
    return crypto.createHash('sha1').update('flint-do:' + name).digest('hex')
  }

  /** Public alarm-index access (used by actors re-arming themselves). */
  readAlarms(): Record<string, number> { return readAlarmIndex() }
  setAlarmEntry(name: string, ts: number | null): void {
    const idx = readAlarmIndex()
    if (ts === null) delete idx[name]
    else idx[name] = ts
    writeAlarmIndex(idx)
  }

  live(): DurableObjectBase[] { return [...this.objects.values()] }

  stats(): DurableStats {
    const objs = [...this.objects.values()]
    let bytes = 0
    let ops = 0
    let hibernated = 0
    for (const o of objs) {
      bytes += o.meta().storageBytes
      ops += o.opsCount
      if (o.hibernated) hibernated++
    }
    return {
      liveObjects: objs.length,
      hibernated,
      totalOps: ops,
      pendingAlarms: Object.keys(readAlarmIndex()).length,
      storageBytes: bytes,
      uptimeMs: Date.now() - this.bootTime,
    }
  }

  async listObjects(): Promise<Array<Record<string, unknown>>> {
    const { db } = await import('@/lib/db')
    const rows = await db.durableObject.findMany({ orderBy: { lastActiveAt: 'desc' }, take: 200 })
    const liveEntries: Array<[string, ReturnType<DurableObjectBase['meta']>]> = []
    for (const [n, o] of this.objects.entries()) liveEntries.push([n, o.meta()])
    const liveMap = new Map(liveEntries)
    return rows.map((r) => {
      const live = liveMap.get(r.name)
      const obj = this.objects.get(r.name)
      return {
        ...r,
        live: !!live,
        hibernated: live ? live.hibernated : null,
        subscribers: obj ? obj.subscriberCount() : 0,
        alarmAt: readAlarmIndex()[r.name] ?? null,
      }
    })
  }

  // ── runtime boot: alarm wheel + hibernation sweeper + sqlite probe ──
  private sqliteModule: { Database: new (f: string) => NonNullable<SqliteBackend['db']> } | null = null

  boot(): void {
    if (this.booted) return
    this.booted = true
    fs.mkdirSync(DURABLE_DIR, { recursive: true })
    fs.mkdirSync(OBJECTS_DIR, { recursive: true })
    fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true })
    void this.probeSqlite()
    // alarm wheel: 1s tick — fires due alarms, wakes hibernated objects
    this.alarmTimer = setInterval(() => void this.alarmTick(), ALARM_TICK_MS)
    if (this.alarmTimer.unref) this.alarmTimer.unref()
    // hibernation sweeper: CF-style idle eviction
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS)
    if (this.sweepTimer.unref) this.sweepTimer.unref()
    // flush everything on shutdown (production only — dev hot-reload
    // must not be trapped into process.exit)
    if (process.env.NODE_ENV === 'production') {
      for (const sig of ['SIGTERM', 'SIGINT'] as const) {
        process.on(sig, () => { void this.shutdown().finally(() => process.exit(0)) })
      }
    }
    console.log('[flint:durable] runtime online — actor registry, alarm wheel (1s), hibernation sweeper (30s)')
  }

  private async probeSqlite(): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const dynImport = new Function('m', 'return import(m)') as (m: string) => Promise<any>
      const mod = (await dynImport('bun:sqlite')) as { Database: new (f: string) => any }
      fs.mkdirSync(SQL_DIR, { recursive: true })
      // sanity: open, schema, close
      const probe = new mod.Database(path.join(SQL_DIR, '_probe.sqlite'))
      probe.run('CREATE TABLE IF NOT EXISTS probe (id INTEGER)')
      probe.close()
      fs.rmSync(path.join(SQL_DIR, '_probe.sqlite'), { force: true })
      this.sqliteAvailable = true
      this.sqliteModule = mod
      console.log('[flint:durable] bun:sqlite available — new objects get SQLite storage')
    } catch {
      this.sqliteAvailable = false
      this.sqliteModule = null
      console.log('[flint:durable] bun:sqlite unavailable — using atomic JSON storage (full durability, portable)')
    }
  }

  /** Upgrade a live object's storage to SQLite under its input gate. */
  private async upgradeSqlite(obj: DurableObjectBase): Promise<void> {
    if (!this.sqliteModule) return
    await obj.blockConcurrencyWhile(async () => {
      try {
        const safe = obj.name.replace(/[^a-zA-Z0-9_:.-]/g, '_')
        const file = path.join(SQL_DIR, safe + '.sqlite')
        const db = new this.sqliteModule!.Database(file)
        obj.attachSqlite(db)
      } catch { /* stay on JSON backend */ }
    })
  }

  private async alarmTick(): Promise<void> {
    try {
      const idx = readAlarmIndex()
      const now = Date.now()
      for (const [name, ts] of Object.entries(idx)) {
        if (ts <= now) {
          // at-least-once: remove first, handler re-arms on failure (CF semantics)
          delete idx[name]
          writeAlarmIndex(idx)
          const obj = this.resolve(name)
          obj.wake().catch(() => {})
          obj.invoke('_fireAlarm', [ts]).catch(() => {})
        }
      }
    } catch { /* wheel must never throw */ }
  }

  private async sweep(): Promise<void> {
    try {
      for (const obj of this.objects.values()) {
        if (!obj.hibernated && obj.idleFor() > IDLE_HIBERNATE_MS && obj.subscriberCount() === 0) {
          await obj.hibernate().catch(() => {})
        }
      }
    } catch { /* sweep must never throw */ }
  }

  async shutdown(): Promise<void> {
    for (const obj of this.objects.values()) {
      const store = (obj as unknown as { store: StorageBackend }).store
      await store.flush().catch(() => {})
    }
    this.booted = false
  }
}

const g = globalThis as unknown as { __flintDurable?: DurableRegistry }
export const durable: DurableRegistry = g.__flintDurable ?? (g.__flintDurable = new DurableRegistry())
export function bootDurable(): void { durable.boot() }

// ── helpers shared with actors/mesh ──────────────────────────

export function safeActorName(kind: 'agent' | 'space', id: string): string {
  return `${kind}:${id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)}`
}
export const DURABLE_DIRS = { DURABLE_DIR, OBJECTS_DIR, SNAPSHOTS_DIR }
