import { NextResponse } from 'next/server'
import { acp } from '@/lib/flint/acp'

export const dynamic = 'force-dynamic'

// GET /api/flint/acp/status — live ACP bridge status for the Studio tab:
// served methods, active connections and their tracked sessions.
export async function GET() {
  return NextResponse.json(acp.status())
}
