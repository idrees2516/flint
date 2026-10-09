import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export async function GET() {
  const templates = await db.template.findMany({ orderBy: [{ isOfficial: 'desc' }, { launches: 'desc' }] })
  return NextResponse.json({ templates })
}
