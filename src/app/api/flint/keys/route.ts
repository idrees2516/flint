import { NextRequest, NextResponse } from 'next/server'
import { createHash, randomBytes } from 'crypto'
import { db } from '@/lib/db'

export async function GET() {
  const keys = await db.apiKey.findMany({
    select: { id: true, name: true, prefix: true, scopes: true, lastUsedAt: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  })
  return NextResponse.json({ keys })
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const name = String(body.name ?? 'key-' + Math.random().toString(36).slice(2, 6))
  const secret = randomBytes(24).toString('base64url')
  const prefix = 'flint-' + randomBytes(4).toString('hex')
  const keyHash = createHash('sha256').update(prefix + '.' + secret).digest('hex')
  const key = await db.apiKey.create({
    data: { name, prefix, keyHash, scopes: String(body.scopes ?? 'sandbox:read,sandbox:write,agent:run') },
  })
  // full key shown exactly once
  return NextResponse.json({ key, secret: `${prefix}.${secret}` })
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  await db.apiKey.delete({ where: { id } }).catch(() => {})
  return NextResponse.json({ ok: true })
}
