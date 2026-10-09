import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export async function GET() {
  const [events, audit] = await Promise.all([
    db.eventLog.findMany({ orderBy: { createdAt: 'desc' }, take: 60 }),
    db.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 40 }),
  ])
  return NextResponse.json({ events, audit })
}
