import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import {
  loadProfilesActiveInCalendarWindow,
  parseDashboardWindowParam,
} from '@/lib/dashboard-window'

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const tenantId = searchParams.get('tenantId')
    const window = searchParams.get('window') || 'L30' // L30 = last 30 days

    if (!tenantId) {
      return NextResponse.json({ error: 'tenantId is required' }, { status: 400 })
    }

    const { windowStart, windowEnd } = parseDashboardWindowParam(window)

    const profiles = await loadProfilesActiveInCalendarWindow(tenantId, windowStart, windowEnd)

    const latestUpload = await prisma.upload.findFirst({
      where: { tenantId, status: 'completed' },
      orderBy: [{ processedAt: 'desc' }, { createdAt: 'desc' }],
      select: { id: true },
    })

    /**
     * Only the *newest* upload row can represent active work. Older rows stuck in
     * `processing` would otherwise keep the dashboard map banner / polling running forever
     * after a newer file has already finished.
     */
    const newestUpload = await prisma.upload.findFirst({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true },
    })
    const processingUploadId =
      newestUpload &&
      (newestUpload.status === 'pending' || newestUpload.status === 'processing')
        ? newestUpload.id
        : null

    // Calculate KPIs
    const totalVisitors = profiles.length
    const engagedVisitors = profiles.filter((p: any) => p.engagementScore >= 3).length
    const repeatVisitors = profiles.filter((p: any) => {
      const flags = p.flags as any
      return flags?.is_repeat_visitor === true
    }).length
    const highIntentVisitors = profiles.filter((p: any) => p.engagementScore >= 6).length

    // New vs Returning: returning = repeat visitors (multiple sessions), new = one-time in window
    const returningVisitors = repeatVisitors
    const newVisitors = totalVisitors - returningVisitors

    // Engagement breakdown
    const engagementBreakdown = {
      Casual: profiles.filter((p: any) => p.engagementSegment === 'Casual').length,
      Researcher: profiles.filter((p: any) => p.engagementSegment === 'Researcher').length,
      HighIntent: profiles.filter((p: any) => p.engagementSegment === 'HighIntent').length,
      Action: profiles.filter((p: any) => p.engagementSegment === 'Action').length,
    }

    // Get top URLs from raw events
    const topUrlsRaw = await prisma.rawEvent.groupBy({
      by: ['url'],
      where: {
        tenantId,
        eventTs: { gte: windowStart, lte: windowEnd },
        url: { not: null },
      },
      _count: { url: true },
      orderBy: { _count: { url: 'desc' } },
      take: 10,
    })

    const topUrls = topUrlsRaw
      .filter((u: any) => u.url)
      .map((u: any) => ({
        url: u.url!,
        visits: u._count.url,
      }))

    // Get top events
    const topEventsRaw = await prisma.rawEvent.groupBy({
      by: ['eventType'],
      where: {
        tenantId,
        eventTs: { gte: windowStart, lte: windowEnd },
        eventType: { not: null },
      },
      _count: { eventType: true },
      orderBy: { _count: { eventType: 'desc' } },
      take: 10,
    })

    const topEvents = topEventsRaw
      .filter((e: any) => e.eventType)
      .map((e: any) => ({
        eventType: e.eventType!,
        count: e._count.eventType,
      }))

    // High intent visitors (top 10)
    const highIntentVisitorsList = profiles
      .filter((p: any) => p.engagementScore >= 6)
      .sort((a: any, b: any) => b.engagementScore - a.engagementScore)
      .slice(0, 10)
      .map((p: any) => ({
        visitorKey: p.visitorKey,
        score: p.engagementScore,
        visits: p.visitsCount,
        timeOnPage: p.totalTimeOnPageMs,
      }))

    // Get IP addresses for each visitor (from their first event)
    // Use a more efficient approach: get all events with IPs, then group by visitor
    const visitorKeys = profiles.map((p: any) => p.visitorKey)
    const eventsWithIp = await prisma.rawEvent.findMany({
      where: {
        tenantId,
        visitorKey: { in: visitorKeys },
        ip: { not: null },
      },
      select: {
        visitorKey: true,
        ip: true,
        eventTs: true,
      },
      orderBy: {
        eventTs: 'asc',
      },
    })

    // Group by visitor and take first IP
    const ipMap = new Map<string, string | null>()
    const seen = new Set<string>()
    for (const event of eventsWithIp) {
      if (!seen.has(event.visitorKey)) {
        ipMap.set(event.visitorKey, event.ip)
        seen.add(event.visitorKey)
      }
    }

    return NextResponse.json({
      windowStart,
      windowEnd,
      latestUploadId: latestUpload?.id ?? null,
      processingUploadId,
      metrics: {
        totalVisitors,
        engagedVisitors,
        repeatVisitors,
        highIntentVisitors,
        newVisitors,
        returningVisitors,
        engagementBreakdown,
        topUrls,
        topEvents,
        highIntentVisitorsList,
      },
      profiles: profiles.map((p: any) => ({
        id: p.id,
        visitorKey: p.visitorKey,
        firstSeenAt: p.firstSeenAt,
        lastSeenAt: p.lastSeenAt,
        visitsCount: p.visitsCount,
        totalEvents: p.totalEvents,
        pageViews: p.pageViews,
        uniquePagesCount: p.uniquePagesCount,
        totalTimeOnPageMs: p.totalTimeOnPageMs,
        avgTimeOnPageMs: p.avgTimeOnPageMs,
        maxScrollPercentage: p.maxScrollPercentage,
        flags: p.flags,
        engagementScore: p.engagementScore,
        engagementSegment: p.engagementSegment,
        lat: p.lat,
        lng: p.lng,
        city: p.city,
        region: p.region,
        country: p.country,
        identity: p.identity,
        ip: ipMap.get(p.visitorKey) || null,
      })),
    })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

