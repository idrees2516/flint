// GET /api/flint/mesh/providers — live provider health, caps, cost tiers
import { NextResponse } from 'next/server'
import { bootMesh, mesh } from '@/lib/flint/mesh'
import { durable } from '@/lib/flint/durable'
import { bootDurableActors } from '@/lib/flint/actors'

export async function GET() {
  bootDurableActors()
  bootMesh()
  const providers = mesh.providerInfos()
  const freeProviders = providers.filter((p) => p.configured && p.costTier === 'free').length
  return NextResponse.json({
    providers,
    summary: {
      total: providers.length,
      configured: providers.filter((p) => p.configured).length,
      freeAvailable: freeProviders,
      scheduling: 'free-first, capability-matched, circuit-broken, cross-provider failover',
    },
    durable: durable.stats(),
  })
}
