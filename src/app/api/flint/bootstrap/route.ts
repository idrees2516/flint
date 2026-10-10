import { NextResponse } from 'next/server'
import { seedFlint } from '@/lib/flint/seed'
import { bootOrchestrator } from '@/lib/flint/orchestrator'
import { bootKernels, kernelManager } from '@/lib/flint/kernel'
import { bootHeartbeats } from '@/lib/flint/heartbeats'
import { registerRlmHostFunctions } from '@/lib/flint/rlm'
import { bus } from '@/lib/flint/events'

let g = globalThis as unknown as { __flintBooted?: boolean }

export async function GET() {
  if (!g.__flintBooted) {
    g.__flintBooted = true
    await seedFlint()
    bootOrchestrator()
    bootKernels()
    registerRlmHostFunctions()
    bootHeartbeats()
    console.log('[flint] bootstrap complete — orchestrator + kernels + heartbeats + RLM host fns')
    bus.emit({
      type: 'fleet:metric',
      source: 'agent',
      message: 'Flint engine online: RLM sessions, kernel manager, heartbeats, factory',
    })
  }
  return NextResponse.json({
    ok: true,
    booted: true,
    version: '1.1.0',
    engine: {
      lanes: 24,
      meter: '1s',
      strategies: ['react', 'dag', 'rlm'],
      kernel: kernelManager.stats(),
    },
  })
}
