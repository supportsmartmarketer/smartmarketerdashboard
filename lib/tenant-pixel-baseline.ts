import { prisma } from '@/lib/prisma'

export type TenantPixelRevenueBaseline = {
  uniqueVisitors: number
  highIntentCount: number
  totalEvents: number
  dataStartDate: Date | null
  dataEndDate: Date | null
  completedUploadCount: number
  pixelFormatsPresent: string[]
}

/**
 * Cross-upload stats for a tenant: distinct visitors, high-intent count, and overall date span.
 * Used so revenue estimates combine V3 + V4 (and multiple files) for one client.
 */
export async function getTenantPixelRevenueBaseline(
  tenantId: string
): Promise<TenantPixelRevenueBaseline> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } })
  if (!tenant) {
    throw new Error('Tenant not found')
  }

  const [rangeAgg, totalEvents, keyRows, formatRows, completedUploadCount] = await Promise.all([
    prisma.rawEvent.aggregate({
      where: { tenantId },
      _min: { eventTs: true },
      _max: { eventTs: true },
    }),
    prisma.rawEvent.count({ where: { tenantId } }),
    prisma.rawEvent.findMany({
      where: { tenantId, visitorKey: { not: 'unknown' } },
      distinct: ['visitorKey'],
      select: { visitorKey: true },
    }),
    prisma.upload.findMany({
      where: { tenantId, status: 'completed', pixelFormat: { not: null } },
      select: { pixelFormat: true },
    }),
    prisma.upload.count({ where: { tenantId, status: 'completed' } }),
  ])

  const keys = keyRows.map((r) => r.visitorKey)
  const uniqueVisitors = keys.length

  let highIntentCount = 0
  const chunkSize = 2000
  for (let i = 0; i < keys.length; i += chunkSize) {
    const chunk = keys.slice(i, i + chunkSize)
    const profiles = await prisma.visitorProfile.findMany({
      where: { tenantId, visitorKey: { in: chunk } },
      orderBy: [{ windowEnd: 'desc' }, { updatedAt: 'desc' }],
      select: { visitorKey: true, engagementScore: true },
    })
    const best = new Map<string, number>()
    for (const p of profiles) {
      if (!best.has(p.visitorKey)) best.set(p.visitorKey, p.engagementScore)
    }
    for (const k of chunk) {
      const s = best.get(k)
      if (s != null && s >= 6) highIntentCount++
    }
  }

  const formatSet = new Set<string>()
  for (const r of formatRows) {
    if (r.pixelFormat) formatSet.add(r.pixelFormat)
  }

  return {
    uniqueVisitors,
    highIntentCount,
    totalEvents,
    dataStartDate: rangeAgg._min.eventTs,
    dataEndDate: rangeAgg._max.eventTs,
    completedUploadCount,
    pixelFormatsPresent: [...formatSet].sort(),
  }
}
