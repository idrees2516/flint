import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// Perf: no query logging in any environment; long timeout for batched writes.
export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
