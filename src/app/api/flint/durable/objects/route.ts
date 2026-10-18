// GET /api/flint/durable/objects — list durable objects (live + DB mirror)
import { NextResponse } from 'next/server'
import { durable } from '@/lib/flint/durable'
import { bootDurableActors } from '@/lib/flint/actors'

export async function GET() {
  bootDurableActors()
  const objects = await durable.listObjects()
  return NextResponse.json({
    stats: durable.stats(),
    sqlite: durable.sqliteAvailable,
    objects,
  })
}
