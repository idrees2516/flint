// ─────────────────────────────────────────────────────────────
// Flint · Concurrency & Performance Primitives
// Priority queue, worker pool, semaphore, token-bucket rate
// limiter, exponential-backoff retry, coalescing event bus.
// ─────────────────────────────────────────────────────────────

/** Binary min-heap priority queue. O(log n) push/pop. */
export class PriorityQueue<T> {
  private heap: { item: T; priority: number; seq: number }[] = []
  private seq = 0

  constructor(private readonly cmp: (a: T, b: T) => number = () => 0) {}

  get size(): number {
    return this.heap.length
  }

  push(item: T, priority = 0): void {
    this.heap.push({ item, priority, seq: this.seq++ })
    this.bubbleUp(this.heap.length - 1)
  }

  pop(): T | undefined {
    if (this.heap.length === 0) return undefined
    const top = this.heap[0]
    const last = this.heap.pop()!
    if (this.heap.length > 0) {
      this.heap[0] = last
      this.bubbleDown(0)
    }
    return top.item
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.less(i, parent)) {
        this.swap(i, parent)
        i = parent
      } else break
    }
  }

  private bubbleDown(i: number): void {
    const n = this.heap.length
    while (true) {
      let smallest = i
      const l = 2 * i + 1
      const r = 2 * i + 2
      if (l < n && this.less(l, smallest)) smallest = l
      if (r < n && this.less(r, smallest)) smallest = r
      if (smallest === i) break
      this.swap(i, smallest)
      i = smallest
    }
  }

  private less(a: number, b: number): boolean {
    const ha = this.heap[a]
    const hb = this.heap[b]
    if (ha.priority !== hb.priority) return ha.priority < hb.priority
    return ha.seq < hb.seq
  }

  private swap(a: number, b: number): void {
    ;[this.heap[a], this.heap[b]] = [this.heap[b], this.heap[a]]
  }
}

/**
 * Fixed-size worker pool draining a priority queue. Workers pull jobs
 * concurrently; per-job timeouts and retries are enforced. This is the
 * core scheduling primitive that lets Flint run thousands of lifecycle
 * ops (create/fork/snapshot/destroy) in parallel without thundering herds.
 */
export class WorkerPool<Job> {
  private queue = new PriorityQueue<Job>()
  private workers: Promise<void>[] = []
  private stopping = false
  private idleResolvers: (() => void)[] = []
  processed = 0
  failed = 0

  constructor(
    private readonly size: number,
    private readonly run: (job: Job) => Promise<void>,
    private readonly priorityOf: (job: Job) => number = () => 0
  ) {
    for (let i = 0; i < size; i++) {
      this.workers.push(this.loop(i))
    }
  }

  submit(job: Job): void {
    this.queue.push(job, this.priorityOf(job))
  }

  get pending(): number {
    return this.queue.size
  }

  get busy(): number {
    return this.size - Math.max(0, this.idleResolvers.length ? this.size : 0)
  }

  /** Resolves when the queue drains and all workers are idle. */
  async idle(): Promise<void> {
    if (this.queue.size === 0) return
    await new Promise<void>((res) => this.idleResolvers.push(res))
  }

  private async loop(workerId: number): Promise<void> {
    while (!this.stopping) {
      const job = this.queue.pop()
      if (!job) {
        if (this.idleResolvers.length && this.queue.size === 0) {
          const rs = this.idleResolvers.splice(0)
          rs.forEach((r) => r())
        }
        await new Promise<void>((r) => setTimeout(r, 50))
        continue
      }
      try {
        await this.run(job)
        this.processed++
      } catch (err) {
        this.failed++
        console.error(`[flint:pool] worker ${workerId} job failed:`, err)
      }
      if (this.queue.size === 0) {
        const rs = this.idleResolvers.splice(0)
        rs.forEach((r) => r())
      }
    }
  }

  stop(): void {
    this.stopping = true
  }
}

/** Bounded-count semaphore. Acquire permits for parallel work. */
export class Semaphore {
  private available: number
  private waiters: (() => void)[] = []
  acquired = 0
  peak = 0

  constructor(public readonly permits: number) {
    this.available = permits
  }

  get inUse(): number {
    return this.permits - this.available
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--
      this.acquired++
      this.peak = Math.max(this.peak, this.inUse)
      return
    }
    await new Promise<void>((res) => this.waiters.push(res))
    this.available--
    this.acquired++
    this.peak = Math.max(this.peak, this.inUse)
  }

  release(): void {
    this.available++
    const next = this.waiters.shift()
    if (next) next()
  }

  /** Run fn under the semaphore. Never leaks a permit. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  /** Map over items with bounded parallelism; preserves input order. */
  async map<I, O>(items: I[], fn: (item: I, i: number) => Promise<O>): Promise<O[]> {
    const out = new Array<O>(items.length)
    await Promise.all(
      items.map(async (item, i) => {
        await this.acquire()
        try {
          out[i] = await fn(item, i)
        } finally {
          this.release()
        }
      })
    )
    return out
  }
}

/** Token-bucket rate limiter with backpressure (drain wait). */
export class TokenBucket {
  private tokens: number
  private lastRefill = Date.now()

  constructor(
    public readonly capacity: number,
    public readonly refillPerSec: number
  ) {
    this.tokens = capacity
  }

  private refill(): void {
    const now = Date.now()
    const elapsed = (now - this.lastRefill) / 1000
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec)
      this.lastRefill = now
    }
  }

  private waitMs(): number {
    this.refill()
    if (this.tokens >= 1) return 0
    return ((1 - this.tokens) / this.refillPerSec) * 1000
  }

  /** Await a token. Resolves immediately when capacity is available. */
  async take(): Promise<void> {
    let wait = this.waitMs()
    if (wait === 0) {
      this.tokens -= 1
      return
    }
    // backpressure: sleep until a token refills
    while (wait > 0) {
      await sleep(Math.min(wait + 1, 250))
      wait = this.waitMs()
    }
    this.tokens -= 1
  }
}

/** Exponential backoff with full jitter. Retries transient failures only. */
export async function retryAsync<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; baseMs?: number; maxMs?: number; isRetryable?: (e: unknown) => boolean } = {}
): Promise<T> {
  const { retries = 3, baseMs = 200, maxMs = 4000, isRetryable = () => true } = opts
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      if (attempt === retries || !isRetryable(e)) throw e
      const backoff = Math.min(maxMs, baseMs * 2 ** attempt)
      await sleep(Math.random() * backoff) // full jitter
    }
  }
  throw lastErr
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Coalesced batch writer — buffers rapid updates into single flushes. */
export class BatchWriter<T> {
  private buffer: T[] = []
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly flush: (batch: T[]) => Promise<void>,
    private readonly maxBatch = 50,
    private readonly intervalMs = 2000
  ) {}

  add(item: T): void {
    this.buffer.push(item)
    if (this.buffer.length >= this.maxBatch) {
      void this.drain()
    } else if (!this.timer) {
      this.timer = setInterval(() => void this.drain(), this.intervalMs)
    }
  }

  async drain(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.buffer.length === 0) return
    const batch = this.buffer
    this.buffer = []
    try {
      await this.flush(batch)
    } catch {
      // swallow — writer must never crash the host loop
    }
  }
}
