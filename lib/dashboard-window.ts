import { prisma } from '@/lib/prisma'
import type { VisitorProfile } from '@prisma/client'

/** Parse dashboard window query e.g. L7, L30, L60 → [start, end] with end = now */
export function parseDashboardWindowParam(window: string): { windowStart: Date; windowEnd: Date } {
  const windowEnd = new Date()
  let windowStart: Date
  if (window.startsWith('L')) {
    const days = parseInt(window.substring(1), 10) || 30
    windowStart = new Date(windowEnd.getTime() - days * 24 * 60 * 60 * 1000)
  } else {
    windowStart = new Date(windowEnd.getTime() - 30 * 24 * 60 * 60 * 1000)
  }
  return { windowStart, windowEnd }
}

/**
 * Visitors who appear in KPIs / lists should have ≥1 event in the calendar window.
 * Profile rows use upload-derived windowStart/windowEnd; overlapping that with "last N days"
 * often returns the same set for every N, so we key off raw_events.event_ts instead.
 */
export async function loadProfilesActiveInCalendarWindow(
  tenantId: string,
  windowStart: Date,
  windowEnd: Date
): Promise<VisitorProfile[]> {
  const keyRows = await prisma.rawEvent.findMany({
    where: {
      tenantId,
      eventTs: { gte: windowStart, lte: windowEnd },
      visitorKey: { not: 'unknown' },
    },
    distinct: ['visitorKey'],
    select: { visitorKey: true },
  })
  const keys = keyRows.map((r) => r.visitorKey)
  if (keys.length === 0) return []

  const CHUNK = 400
  const byKey = new Map<string, VisitorProfile>()
  for (let i = 0; i < keys.length; i += CHUNK) {
    const slice = keys.slice(i, i + CHUNK)
    const profilesRaw = await prisma.visitorProfile.findMany({
      where: { tenantId, visitorKey: { in: slice } },
      orderBy: { windowEnd: 'desc' },
    })
    for (const p of profilesRaw) {
      if (!byKey.has(p.visitorKey)) byKey.set(p.visitorKey, p)
    }
  }
  return [...byKey.values()]
}
