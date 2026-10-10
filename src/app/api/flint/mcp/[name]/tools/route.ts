import { NextRequest, NextResponse } from 'next/server'
import { listTools } from '@/lib/flint/mcp'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params
  try {
    const tools = await listTools(name)
    return NextResponse.json({ tools })
  } catch (e) {
    return NextResponse.json({ error: String(e), tools: [] }, { status: 200 })
  }
}
