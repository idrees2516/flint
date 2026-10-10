import { NextRequest, NextResponse } from 'next/server'
import { deleteItem, listItems, refinementHistory, searchHarness, upsertItem } from '@/lib/flint/harness'

export async function GET(req: NextRequest) {
  const kind = req.nextUrl.searchParams.get('kind') ?? undefined
  const q = req.nextUrl.searchParams.get('q') ?? undefined
  const [items, refinements] = await Promise.all([
    q ? searchHarness(q) : listItems(kind),
    refinementHistory(),
  ])
  return NextResponse.json({ items, refinements })
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  try {
    const item = await upsertItem({
      kind: String(body.kind ?? ''),
      name: String(body.name ?? ''),
      content: String(body.content ?? ''),
      scope: body.scope === 'session' ? 'session' : 'global',
      sessionId: body.sessionId ? String(body.sessionId) : null,
      tags: body.tags ? String(body.tags) : '',
      actor: 'console',
    })
    return NextResponse.json({ item })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 })
  }
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id') ?? ''
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  await deleteItem(id)
  return NextResponse.json({ ok: true })
}
