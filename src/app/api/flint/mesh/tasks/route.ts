// GET /api/flint/mesh/tasks — mesh task history
import { NextRequest, NextResponse } from 'next/server'
import { bootMesh, mesh } from '@/lib/flint/mesh'

export async function GET(req: NextRequest) {
  bootMesh()
  const limit = Number(new URL(req.url).searchParams.get('limit') ?? 50)
  const tasks = await mesh.listTasks(limit)
  return NextResponse.json({ tasks })
}
