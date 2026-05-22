import { prisma } from './prisma'

export type AISummarySignalDepth = 'rich' | 'sparse' | 'mixed'

export interface PixelReportingContext {
  pixelFormatsPresent: string[]
  signalDepth: AISummarySignalDepth
  /** Raw events counted in dashboard window */
  eventsInWindow: number
  eventsWithDwellOrScroll: number
  dwellOrScrollFraction: number
  pageViewDominanceFraction: number
  distinctRecordedEventTypes: number
  /** Visitors in window whose profile carries identity cues suitable for outbound (no PII surfaced to model beyond counts). */
  profilesWithResolvableContactHints: number
  totalProfilesInWindow: number
}

function normalizePixelFormats(rows: Array<{ pixelFormat: string | null }>): string[] {
  const s = new Set<string>()
  for (const r of rows) {
    if (r.pixelFormat) s.add(String(r.pixelFormat).toLowerCase())
  }
  return [...s].sort()
}

function profileHasOutboundHints(identity: unknown): boolean {
  if (!identity || typeof identity !== 'object') return false
  const o = identity as Record<string, unknown>
  const email = String(o.businessEmail ?? o.business_email ?? '').trim()
  const phone = String(o.phone ?? o.mobilePhone ?? o.mobile_phone ?? '').trim()
  const first = String(o.firstName ?? '').trim()
  const last = String(o.lastName ?? '').trim()
  const company = String(o.companyName ?? '').trim()
  const nameBlob = `${first} ${last}`.trim()
  return !!(email || phone || company || nameBlob.length > 2)
}

function inferSignalDepth(opts: {
  formats: string[]
  dwellFrac: number
  pageViewFrac: number
  eventsInWindow: number
  distinctRecordedEventTypes: number
}): AISummarySignalDepth {
  const hasV3 = opts.formats.includes('v3')
  const hasV4 = opts.formats.includes('v4')
  const trivial = opts.eventsInWindow <= 20

  if (hasV3 && hasV4) return 'mixed'

  const behaviorallyThin =
    opts.dwellFrac < 0.1 &&
    (opts.pageViewFrac >= 0.85 || opts.distinctRecordedEventTypes <= 2)

  if (hasV4 && !hasV3) {
    if (behaviorallyThin && opts.eventsInWindow > 40) return 'sparse'
    return opts.dwellFrac >= 0.12 ? 'rich' : 'sparse'
  }

  if (hasV3 && !hasV4) {
    if (trivial) return opts.dwellFrac >= 0.03 ? 'rich' : 'sparse'
    return opts.dwellFrac >= 0.05 ? 'rich' : 'sparse'
  }

  if (behaviorallyThin && opts.eventsInWindow > 40) return 'sparse'
  return opts.dwellFrac >= 0.08 ? 'rich' : 'sparse'
}

/**
 * Telemetry for AI prompts — what the export realistically supports vs identity-led plays.
 */
export async function buildPixelReportingContext(params: {
  tenantId: string
  windowStart: Date
  windowEnd: Date
  /** Profiles already loaded for the dashboard window (`identity` field). */
  profiles: ReadonlyArray<{ identity: unknown | null }>
}): Promise<PixelReportingContext> {
  const { tenantId, windowStart, windowEnd, profiles } = params

  const [formatUploads, eventsInWindow, eventsWithDwellOrScroll, typeGroups] = await Promise.all([
    prisma.upload.findMany({
      where: { tenantId, status: 'completed', pixelFormat: { not: null } },
      select: { pixelFormat: true },
    }),
    prisma.rawEvent.count({
      where: {
        tenantId,
        eventTs: { gte: windowStart, lte: windowEnd },
      },
    }),
    prisma.rawEvent.count({
      where: {
        tenantId,
        eventTs: { gte: windowStart, lte: windowEnd },
        OR: [{ timeOnPageMs: { gt: 0 } }, { scrollPct: { gt: 0 } }],
      },
    }),
    prisma.rawEvent.groupBy({
      by: ['eventType'],
      where: {
        tenantId,
        eventTs: { gte: windowStart, lte: windowEnd },
        eventType: { not: null },
      },
      _count: { eventType: true },
    }),
  ])

  const pixelFormatsPresent = normalizePixelFormats(formatUploads)

  const dwellOrScrollFraction = eventsInWindow > 0 ? eventsWithDwellOrScroll / eventsInWindow : 0

  const pageViewHits = typeGroups.reduce((acc, row) => {
    const et = (row.eventType || '').toLowerCase()
    const c = row._count.eventType
    const isPv =
      et.includes('page_view') || et.includes('pageview') || et === '' || et === 'view'
    return isPv ? acc + c : acc
  }, 0)

  const pageViewDominanceFraction = eventsInWindow > 0 ? pageViewHits / eventsInWindow : 0

  const distinctRecordedEventTypes = typeGroups.filter((r) => r.eventType).length

  const signalDepth = inferSignalDepth({
    formats: pixelFormatsPresent,
    dwellFrac: dwellOrScrollFraction,
    pageViewFrac: pageViewDominanceFraction,
    eventsInWindow,
    distinctRecordedEventTypes,
  })

  let profilesWithResolvableContactHints = 0
  for (const p of profiles) {
    if (profileHasOutboundHints(p.identity)) profilesWithResolvableContactHints++
  }

  return {
    pixelFormatsPresent,
    signalDepth,
    eventsInWindow,
    eventsWithDwellOrScroll,
    dwellOrScrollFraction: Number(dwellOrScrollFraction.toFixed(4)),
    pageViewDominanceFraction: Number(pageViewDominanceFraction.toFixed(4)),
    distinctRecordedEventTypes,
    profilesWithResolvableContactHints,
    totalProfilesInWindow: profiles.length,
  }
}
