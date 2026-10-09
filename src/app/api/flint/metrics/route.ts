import { NextResponse } from 'next/server'
import { fleetMetrics } from '@/lib/flint/orchestrator'

export const dynamic = 'force-dynamic'

export async function GET() {
  const metrics = await fleetMetrics()
  return NextResponse.json({ metrics })
}
