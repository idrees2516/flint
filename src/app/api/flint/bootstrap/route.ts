import { NextResponse } from 'next/server'
import { seedFlint } from '@/lib/flint/seed'
import { bootOrchestrator } from '@/lib/flint/orchestrator'
import { bootKernels, kernelManager } from '@/lib/flint/kernel'
import { bootHeartbeats } from '@/lib/flint/heartbeats'
import { registerRlmHostFunctions } from '@/lib/flint/rlm'
import { bootDurableActors } from '@/lib/flint/actors'
import { bootMesh, mesh } from '@/lib/flint/mesh'
import { durable } from '@/lib/flint/durable'
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
    bootDurableActors() // durable runtime: actors + alarms + hibernation + bus mirroring
    bootMesh() // stateless sandbox mesh: 7 providers, free-first routing
    console.log('[flint] bootstrap complete — orchestrator + kernels + heartbeats + durable actors + sandbox mesh')
    bus.emit({
      type: 'fleet:metric',
      source: 'agent',
      message: 'Flint engine online: RLM sessions, durable actors, stateless sandbox mesh, heartbeats, factory',
    })
  }
  return NextResponse.json({
    ok: true,
    booted: true,
    version: '1.2.0',
    engine: {
      lanes: 24,
      meter: '1s',
      strategies: ['react', 'dag', 'rlm'],
      kernel: kernelManager.stats(),
      durable: durable.stats(),
      meshProviders: mesh.providerInfos().map((p) => ({ id: p.id, status: p.status, free: p.costTier === 'free' })),
    },
  })
}
