import { NextRequest, NextResponse } from 'next/server'
import { callTool } from '@/lib/flint/mcp'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const server = String(body.server ?? '')
  const tool = String(body.tool ?? '')
  if (!server || !tool) return NextResponse.json({ error: 'server and tool required' }, { status: 400 })
  try {
    const result = await callTool(server, tool, (body.args as Record<string, unknown>) ?? {})
    return NextResponse.json({ result })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 })
  }
}
