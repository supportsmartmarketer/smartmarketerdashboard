import { NextRequest, NextResponse } from 'next/server'
import {
  getOrGenerateSummary,
  normalizeKeyObservations,
  normalizePriorityAction,
  normalizeRevenueInsights,
} from '@/lib/ai-summary'
import { buildPixelReportingContext } from '@/lib/ai-summary-pixel-context'
import { prisma } from '@/lib/prisma'
import {
  loadProfilesActiveInCalendarWindow,
  parseDashboardWindowParam,
} from '@/lib/dashboard-window'

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const tenantId = searchParams.get('tenantId')
    const window = searchParams.get('window') || 'L30'

    if (!tenantId) {
      return NextResponse.json({ error: 'tenantId is required' }, { status: 400 })
    }

    const { windowStart, windowEnd } = parseDashboardWindowParam(window)

    // Get existing summary
    const summary = await prisma.tenantSummary.findUnique({
      where: {
        tenantId_windowStart_windowEnd: {
          tenantId,
          windowStart,
          windowEnd,
        },
      },
    })

    if (summary) {
      return NextResponse.json({
        id: summary.id,
        executiveSummary: summary.executiveSummary,
        keyObservations: normalizeKeyObservations(summary.keyObservations),
        recommendedActions: summary.recommendedActions,
        notableSegments: summary.notableSegments,
        priorityAction: normalizePriorityAction(summary.priorityAction),
        revenueInsights: normalizeRevenueInsights(summary.revenueInsights),
        createdAt: summary.createdAt,
      })
    }

    return NextResponse.json({ error: 'Summary not found. Generate it first.' }, { status: 404 })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { tenantId, window = 'L30', forceRegenerate = false, roiContext } = body

    if (!tenantId) {
      return NextResponse.json({ error: 'tenantId is required' }, { status: 400 })
    }

    const { windowStart, windowEnd } = parseDashboardWindowParam(window)

    const profiles = await loadProfilesActiveInCalendarWindow(tenantId, windowStart, windowEnd)

    const totalVisitors = profiles.length
    const engagedVisitors = profiles.filter((p: any) => p.engagementScore >= 3).length
    const repeatVisitors = profiles.filter((p: any) => {
      const flags = p.flags as any
      return flags?.is_repeat_visitor === true
    }).length
    const highIntentVisitors = profiles.filter((p: any) => p.engagementScore >= 6).length
    const newVisitors = profiles.filter(
      (p: any) => p.firstSeenAt >= windowStart && p.firstSeenAt <= windowEnd
    ).length
    const returningVisitors = totalVisitors - newVisitors

    const engagementBreakdown = {
      Casual: profiles.filter((p: any) => p.engagementSegment === 'Casual').length,
      Researcher: profiles.filter((p: any) => p.engagementSegment === 'Researcher').length,
      HighIntent: profiles.filter((p: any) => p.engagementSegment === 'HighIntent').length,
      Action: profiles.filter((p: any) => p.engagementSegment === 'Action').length,
    }

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

    const metrics = {
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
    }

    const pixelReporting = await buildPixelReportingContext({
      tenantId,
      windowStart,
      windowEnd,
      profiles,
    })

    // Generate summary
    const summary = await getOrGenerateSummary(
      tenantId,
      windowStart,
      windowEnd,
      metrics,
      forceRegenerate,
      roiContext,
      pixelReporting
    )

    return NextResponse.json(summary)
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

