import { NextRequest, NextResponse } from 'next/server'
import { MCP_CATALOG, deleteMcpServer, listMcpServers, upsertMcpServer } from '@/lib/flint/mcp'

export async function GET() {
  const servers = await listMcpServers()
  return NextResponse.json({ servers, catalog: MCP_CATALOG })
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const name = String(body.name ?? '').trim()
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })
  try {
    const server = await upsertMcpServer({
      name,
      transport: body.transport === 'stdio' ? 'stdio' : 'http',
      url: body.url ? String(body.url) : undefined,
      command: body.command ? String(body.command) : undefined,
      bearerTokenEnvVar: body.bearerTokenEnvVar ? String(body.bearerTokenEnvVar) : undefined,
      enabled: body.enabled !== false,
    })
    return NextResponse.json({ server })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 })
  }
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id') ?? ''
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  await deleteMcpServer(id)
  return NextResponse.json({ ok: true })
}
