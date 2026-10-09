import { NextResponse } from 'next/server'
import { seedFlint } from '@/lib/flint/seed'
import { bootOrchestrator } from '@/lib/flint/orchestrator'
import { bus } from '@/lib/flint/events'

let g = globalThis as unknown as { __flintBooted?: boolean }

export async function GET() {
  if (!g.__flintBooted) {
    g.__flintBooted = true
    await seedFlint()
    bootOrchestrator()
    console.log('[flint] bootstrap complete')
  }
  return NextResponse.json({
    ok: true,
    booted: true,
    version: '1.0.0',
    engine: { lanes: 24, meter: '1s', strategies: ['react', 'dag'] },
  })
}
