import { Readable } from 'stream'
import Papa from 'papaparse'
import { prisma } from './prisma'
import { parseCoordinates, getGeoLocation } from './geo'
import {
  calculateEngagementScore,
  calculateEngagementScoreSparseBehavior,
  eventsHaveSparseBehavioralSignals,
  getEngagementSegment,
  isExitIntent,
  isVideoEngaged,
  VisitorFlags,
} from './scoring'
import {
  isMissingDbColumn,
  matchesCtaEvent,
  matchesKeyPage,
  normalizeTrackingConfig,
  type TenantTrackingConfig,
} from './tenant-tracking-config'
import { detectPixelFormatFromCsvRow, type PixelFormat } from './pixel-format'

/** Progress polling; ignore if `processed_rows` column is missing on old DBs. */
async function safeUploadSetProcessedRows(uploadId: string, processedRows: number) {
  try {
    await prisma.upload.update({
      where: { id: uploadId },
      data: { processedRows },
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!msg.includes('processed_rows')) throw e
  }
}

/** Live visitor-profile build progress; ignore if DB columns are missing. */
async function safeUploadSetPixelFormat(uploadId: string, pixelFormat: PixelFormat) {
  try {
    await prisma.upload.update({
      where: { id: uploadId },
      data: { pixelFormat },
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!msg.includes('pixel_format')) throw e
  }
}

async function safeUploadSetVisitorProfileProgress(
  uploadId: string,
  processed: number,
  total: number
) {
  try {
    await prisma.upload.update({
      where: { id: uploadId },
      data: {
        visitorProfileProcessed: processed,
        visitorProfileTotal: total,
      },
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!msg.includes('visitor_profile')) throw e
  }
}

export interface CSVRow {
  [key: string]: string | undefined
}

export interface ProcessedEvent {
  visitorKey: string
  uuid?: string
  ip?: string
  eventTs: Date
  eventType?: string
  url?: string
  referrerUrl?: string
  timeOnPageMs?: number
  idleTimeMs?: number
  scrollPct?: number
  threshold?: string
  elementIdentifier?: string
  elementText?: string
  title?: string
  coordinates?: { lat: number; lng: number } | null
  rawJson?: any
}

/**
 * Normalize timestamp to UTC ISO; returns null if invalid or out of reasonable range
 */
function normalizeTimestamp(value: string | undefined): Date | null {
  if (!value || typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    const d = new Date(trimmed)
    if (Number.isNaN(d.getTime())) return null
    const year = d.getFullYear()
    if (year < 2000 || year > 2030) return null
    return d
  } catch {
    return null
  }
}

/** Known timestamp column names (order matters: most common first) */
const TIMESTAMP_KEYS = [
  'EVENT_TIMESTAMP', 'Event Timestamp', 'event_timestamp',
  'timestamp', 'Timestamp', 'created_at', 'Created At', 'Created At (UTC)',
  'event_time', 'Event Time', 'event time', 'time', 'Time', 'date', 'Date',
  'datetime', 'DateTime', 'created', 'Created', 'Date (UTC)', 'date_utc',
]

function getTimestampFromRow(row: CSVRow): Date | null {
  for (const key of TIMESTAMP_KEYS) {
    const val = row[key]
    if (val !== undefined && val !== '') {
      const d = normalizeTimestamp(val)
      if (d) return d
    }
  }
  // Do not scan arbitrary columns: V3/V4 enrichment fields often contain ISO-like dates
  // (e.g. LinkedIn extraction_date) that are not the pixel hit time and would skew ranges.
  return null
}

interface EventDataExtracted {
  url?: string
  referrerUrl?: string
  title?: string
  timeOnPageMs?: number
  idleTimeMs?: number
  scrollPctFromEvent?: number
  thresholdFromEvent?: string
}

function extractEventDataFromRow(row: CSVRow): EventDataExtracted {
  const out: EventDataExtracted = {}
  if (!row['EVENT_DATA']) return out
  try {
    const eventDataStr =
      typeof row['EVENT_DATA'] === 'string' ? row['EVENT_DATA'] : JSON.stringify(row['EVENT_DATA'])
    const eventData = JSON.parse(eventDataStr)

    out.url = eventData?.url || undefined
    out.referrerUrl = eventData?.referrer || undefined
    out.title = eventData?.title || undefined

    if (eventData?.timeOnPage) {
      out.timeOnPageMs = Math.max(0, Math.min(600000, parseInt(eventData.timeOnPage)))
    }
    if (eventData?.idleTime) {
      out.idleTimeMs = Math.max(0, parseInt(eventData.idleTime))
    }
    if (eventData?.percentage != null) {
      const pct =
        typeof eventData.percentage === 'number'
          ? eventData.percentage
          : parseFloat(String(eventData.percentage))
      if (!Number.isNaN(pct)) out.scrollPctFromEvent = Math.max(0, Math.min(100, pct))
    }
    if (eventData?.threshold != null) {
      out.thresholdFromEvent = String(eventData.threshold)
    }
  } catch {
    // invalid JSON — column fallbacks only
  }
  return out
}

function pickUrlFromColumns(row: CSVRow): string | undefined {
  return (
    row['URL'] ||
    row['Url'] ||
    row['url'] ||
    row['FULL_URL'] ||
    row['Full Url'] ||
    row['full_url'] ||
    undefined
  )
}

function pickReferrerFromColumns(row: CSVRow): string | undefined {
  return (
    row['REFERRER_URL'] ||
    row['Referrer Url'] ||
    row['Referrer'] ||
    row['referrer_url'] ||
    row['referrer'] ||
    undefined
  )
}

function pickEventsColumn(row: CSVRow): string | undefined {
  const raw = row['EVENTS'] || row['Events'] || row['events']
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
}

function absolutizePathOrUrl(pathOrUrl: string, fullUrl?: string): string {
  if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) return pathOrUrl
  if (fullUrl) {
    try {
      const origin = new URL(fullUrl).origin
      return pathOrUrl.startsWith('/') ? `${origin}${pathOrUrl}` : `${origin}/${pathOrUrl}`
    } catch {
      /* ignore */
    }
  }
  return pathOrUrl
}

function urlFromV4EventProperties(
  props: Record<string, unknown> | undefined,
  fallbackFullUrl?: string
): string | undefined {
  if (!props) return fallbackFullUrl
  const urlVal = props.url ?? props.URL
  if (typeof urlVal === 'string' && urlVal.trim()) {
    const u = urlVal.trim()
    return u.startsWith('http') ? u : absolutizePathOrUrl(u, fallbackFullUrl)
  }
  const pathVal = props.path ?? props.PATH
  if (typeof pathVal === 'string' && pathVal.trim()) {
    return absolutizePathOrUrl(pathVal.trim(), fallbackFullUrl)
  }
  return fallbackFullUrl
}

type V4EventsColumnItem = {
  event?: string
  received_at?: string
  properties?: Record<string, unknown>
}

/**
 * Expand V4 EVENTS JSON array (page_view, deep_scroll, form_submit, exit_intent, …) into multiple ProcessedEvents.
 */
function parseV4EventsColumn(row: CSVRow, base: ProcessedEvent): ProcessedEvent[] | null {
  const eventsJson = pickEventsColumn(row)
  if (!eventsJson?.startsWith('[')) return null

  let items: V4EventsColumnItem[]
  try {
    const parsed = JSON.parse(eventsJson) as unknown
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    items = parsed as V4EventsColumnItem[]
  } catch {
    return null
  }

  const fallbackFullUrl = pickUrlFromColumns(row)
  const referrerUrl = base.referrerUrl || pickReferrerFromColumns(row)
  const out: ProcessedEvent[] = []

  for (const item of items) {
    const eventTs = normalizeTimestamp(item.received_at) ?? base.eventTs
    const props = item.properties
    const url = urlFromV4EventProperties(props, fallbackFullUrl)

    let scrollPct: number | undefined
    const scrollRaw = props?.scrollDepth ?? props?.scroll_depth ?? props?.percentage
    if (scrollRaw != null) {
      const n = typeof scrollRaw === 'number' ? scrollRaw : parseFloat(String(scrollRaw))
      if (!Number.isNaN(n)) scrollPct = Math.max(0, Math.min(100, n))
    }

    const formId = props?.formId ?? props?.form_id
    const elementIdentifier =
      typeof formId === 'string' && formId.trim()
        ? formId.trim()
        : typeof props?.elementId === 'string'
          ? props.elementId.trim()
          : typeof props?.element_id === 'string'
            ? props.element_id.trim()
            : undefined

    const textRaw =
      props?.elementText ??
      props?.element_text ??
      props?.linkText ??
      props?.link_text ??
      props?.innerText ??
      props?.inner_text ??
      props?.buttonText ??
      props?.button_text ??
      props?.text ??
      props?.label ??
      props?.ctaText ??
      props?.cta_text
    const elementText = typeof textRaw === 'string' && textRaw.trim() ? textRaw.trim() : undefined

    let timeOnPageMs: number | undefined
    const timeRaw =
      props?.timeOnPage ??
      props?.time_on_page ??
      props?.dwellTime ??
      props?.dwell_time ??
      props?.durationMs ??
      props?.duration_ms
    if (timeRaw != null) {
      const n = typeof timeRaw === 'number' ? timeRaw : parseInt(String(timeRaw), 10)
      if (!Number.isNaN(n) && n >= 0) timeOnPageMs = Math.max(0, Math.min(600000, n))
    }

    out.push({
      visitorKey: base.visitorKey,
      uuid: base.uuid,
      ip: base.ip,
      eventTs,
      eventType: item.event?.trim() || 'page_view',
      url,
      referrerUrl,
      scrollPct,
      elementIdentifier,
      elementText,
      timeOnPageMs,
      rawJson: row,
    })
  }

  return out.length > 0 ? out : null
}

/**
 * One CSV row → one or many ProcessedEvents (V4 EVENTS column expands to full journey).
 */
export function parseRowsFromCsvRow(row: CSVRow): ProcessedEvent[] {
  const base = parseRow(row)
  if (!base) return []
  const expanded = parseV4EventsColumn(row, base)
  if (expanded) {
    for (const e of expanded) e.rawJson = undefined
    return expanded
  }
  return [base]
}

/**
 * Parse CSV row into ProcessedEvent (Smart Pixel export: EVENT_TYPE, EVENT_DATA JSON, URL columns, IP, etc.).
 */
export function parseRow(row: CSVRow): ProcessedEvent | null {
  const eventTs = getTimestampFromRow(row)
  if (!eventTs) return null

  const hemSha256 = row['HEM_SHA256'] || row['Hem Sha256'] || row['hem_sha256'] || undefined
  const uuid = row['UUID'] || row['Uuid'] || row['uuid'] || undefined
  const ip = row['IP_ADDRESS'] || row['Ip Address'] || row['ip_address'] || row['ip'] || undefined
  const edid =
    row['EDID']?.trim() || row['Edid']?.trim() || row['edid']?.trim() || undefined
  const visitorKey = hemSha256 || uuid || ip || edid || 'unknown'

  const ed = extractEventDataFromRow(row)
  const url = ed.url || pickUrlFromColumns(row)
  const referrerUrl = ed.referrerUrl || pickReferrerFromColumns(row)

  let timeOnPageMs = ed.timeOnPageMs
  let idleTimeMs = ed.idleTimeMs
  const title = ed.title
  const scrollPctFromEvent = ed.scrollPctFromEvent
  const thresholdFromEvent = ed.thresholdFromEvent
  if (!timeOnPageMs) {
    const timeOnPage = row['Timeonpage'] || row['time_on_page'] || row['timeonpage'] || row['TIME_ON_PAGE']
    timeOnPageMs = timeOnPage ? Math.max(0, Math.min(600000, parseInt(timeOnPage) * 1000)) : undefined
  }
  if (!timeOnPageMs) {
    // Smart Pixel: ACTIVITY_START_DATE and ACTIVITY_END_DATE give time spent on the row (in seconds)
    const startStr = row['ACTIVITY_START_DATE'] || row['Activity Start Date'] || row['activity_start_date']
    const endStr = row['ACTIVITY_END_DATE'] || row['Activity End Date'] || row['activity_end_date']
    if (startStr && endStr) {
      const startTs = normalizeTimestamp(startStr)?.getTime()
      const endTs = normalizeTimestamp(endStr)?.getTime()
      if (startTs != null && endTs != null && endTs >= startTs) {
        const seconds = Math.max(0, Math.min(600, (endTs - startTs) / 1000))
        timeOnPageMs = Math.round(seconds) * 1000
      }
    }
  }
  if (!idleTimeMs) {
    const idleTime = row['Idletime'] || row['idle_time'] || row['idletime'] || row['IDLE_TIME']
    idleTimeMs = idleTime ? Math.max(0, parseInt(idleTime) * 1000) : undefined
  }

  const scrollPct = scrollPctFromEvent ?? (row['Percentage'] || row['percentage'] || row['scroll_percentage'] || row['SCROLL_PERCENTAGE'])
  const scrollPctNum =
    scrollPct != null
      ? (typeof scrollPct === 'number' ? scrollPct : parseFloat(String(scrollPct)))
      : undefined
  const scrollPctNumValid = scrollPctNum != null && !Number.isNaN(scrollPctNum) ? scrollPctNum : undefined

  const coordinates = parseCoordinates(
    row['Coordinates'] || row['coordinates'] || undefined
  )

  let eventType = row['EVENT_TYPE'] || row['Event Type'] || row['event_type'] || undefined
  if (!eventType && url) {
    eventType = 'page_view'
  }

  return {
    visitorKey,
    uuid,
    ip,
    eventTs,
    eventType,
    url,
    referrerUrl,
    timeOnPageMs,
    idleTimeMs,
    scrollPct: scrollPctNumValid,
    threshold: thresholdFromEvent ?? (row['Threshold'] || row['threshold'] || row['THRESHOLD'] || undefined),
    elementIdentifier: row['Elementidentifier'] || row['Element Identifier'] || row['element_identifier'] || row['ELEMENT_IDENTIFIER'] || undefined,
    elementText: row['Elementtext'] || row['Element Text'] || row['element_text'] || row['ELEMENT_TEXT'] || undefined,
    title,
    coordinates,
    rawJson: row,
  }
}

/** Compact identity extracted from a single CSV row (only stored once per visitor) */
interface IdentityData {
  firstName?: string
  lastName?: string
  companyName?: string
  companyDomain?: string
  jobTitle?: string
  seniorityLevel?: string
  businessEmail?: string
  phone?: string
  mobilePhone?: string
  address?: string
  companyAddress?: string
  city?: string
  state?: string
  zip?: string
  country?: string
}

function extractIdentityFromRow(row: CSVRow): IdentityData {
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = row[k]
      if (v && v !== '-' && v.trim() !== '') return v.trim()
    }
    return undefined
  }
  return {
    firstName:      pick('FIRST_NAME', 'First Name', 'first_name'),
    lastName:       pick('LAST_NAME', 'Last Name', 'last_name'),
    companyName:    pick('COMPANY_NAME', 'Company Name', 'company_name'),
    companyDomain:  pick('COMPANY_DOMAIN', 'Company Domain', 'company_domain'),
    jobTitle:       pick('JOB_TITLE', 'Job Title', 'job_title'),
    seniorityLevel: pick('SENIORITY_LEVEL', 'Seniority Level', 'seniority_level'),
    businessEmail:  pick('BUSINESS_EMAIL', 'Business Email', 'business_email'),
    phone: pick(
      'DIRECT_NUMBER',
      'Direct Number',
      'direct_number',
      'ALL_LANDLINES',
      'All Landlines',
      'all_landlines'
    ),
    mobilePhone: pick(
      'MOBILE_PHONE',
      'Mobile Phone',
      'mobile_phone',
      'ALL_MOBILES',
      'All Mobiles',
      'all_mobiles'
    ),
    address:        pick('PERSONAL_ADDRESS', 'Personal Address', 'personal_address'),
    companyAddress: pick('COMPANY_ADDRESS', 'Company Address', 'company_address'),
    city:           pick('PERSONAL_CITY', 'Personal City', 'personal_city', 'COMPANY_CITY', 'Company City', 'company_city'),
    state:          pick('PERSONAL_STATE', 'Personal State', 'personal_state', 'COMPANY_STATE', 'Company State', 'company_state'),
    zip:            pick('PERSONAL_ZIP', 'Personal Zip', 'personal_zip', 'COMPANY_ZIP', 'Company Zip', 'company_zip'),
    country:        pick('PERSONAL_COUNTRY', 'Personal Country', 'personal_country', 'COMPANY_COUNTRY', 'Company Country', 'company_country'),
  }
}

/**
 * Group events into sessions (30 minute gap threshold)
 */
function groupIntoSessions(events: ProcessedEvent[]): ProcessedEvent[][] {
  if (events.length === 0) return []
  
  const sorted = [...events].sort((a, b) => a.eventTs.getTime() - b.eventTs.getTime())
  const sessions: ProcessedEvent[][] = []
  let currentSession: ProcessedEvent[] = [sorted[0]]

  for (let i = 1; i < sorted.length; i++) {
    const prevTime = sorted[i - 1].eventTs.getTime()
    const currTime = sorted[i].eventTs.getTime()
    const gapMinutes = (currTime - prevTime) / (1000 * 60)

    if (gapMinutes <= 30) {
      currentSession.push(sorted[i])
    } else {
      sessions.push(currentSession)
      currentSession = [sorted[i]]
    }
  }

  if (currentSession.length > 0) {
    sessions.push(currentSession)
  }

  return sessions
}

/** Infer session length from first→last event when dwell time is missing (typical V4). */
function inferSessionDurationMs(session: ProcessedEvent[]): number {
  if (session.length === 0) return 0
  if (session.length === 1) return session[0].timeOnPageMs || 0
  const start = session[0].eventTs.getTime()
  const end = session[session.length - 1].eventTs.getTime()
  return Math.min(30 * 60 * 1000, Math.max(0, end - start))
}

/**
 * Total dwell: max explicit timeOnPage per session (V3 idle/exit), else infer from event timestamps.
 */
function computeTotalTimeOnPageMs(events: ProcessedEvent[], sessions: ProcessedEvent[][]): number {
  let total = 0
  for (const session of sessions) {
    const explicit = session.map((e) => e.timeOnPageMs || 0).filter((t) => t > 0)
    if (explicit.length > 0) {
      total += Math.max(...explicit)
    } else {
      total += inferSessionDurationMs(session)
    }
  }
  if (total === 0 && events.length >= 2) {
    return inferSessionDurationMs([...events].sort((a, b) => a.eventTs.getTime() - b.eventTs.getTime()))
  }
  return total
}

const RAW_EVENT_SELECT = {
  visitorKey: true,
  uuid: true,
  ip: true,
  eventTs: true,
  eventType: true,
  url: true,
  referrerUrl: true,
  timeOnPageMs: true,
  idleTimeMs: true,
  scrollPct: true,
  threshold: true,
  elementIdentifier: true,
  elementText: true,
  title: true,
  coordinates: true,
} as const

function mapRawEventToProcessed(r: {
  visitorKey: string
  uuid: string | null
  ip: string | null
  eventTs: Date
  eventType: string | null
  url: string | null
  referrerUrl: string | null
  timeOnPageMs: number | null
  idleTimeMs: number | null
  scrollPct: number | null
  threshold: string | null
  elementIdentifier: string | null
  elementText: string | null
  title: string | null
  coordinates: unknown
}): ProcessedEvent {
  return {
    visitorKey: r.visitorKey,
    uuid: r.uuid ?? undefined,
    ip: r.ip ?? undefined,
    eventTs: r.eventTs,
    eventType: r.eventType ?? undefined,
    url: r.url ?? undefined,
    referrerUrl: r.referrerUrl ?? undefined,
    timeOnPageMs: r.timeOnPageMs ?? undefined,
    idleTimeMs: r.idleTimeMs ?? undefined,
    scrollPct: r.scrollPct ?? undefined,
    threshold: r.threshold ?? undefined,
    elementIdentifier: r.elementIdentifier ?? undefined,
    elementText: r.elementText ?? undefined,
    title: r.title ?? undefined,
    coordinates: r.coordinates as { lat: number; lng: number } | null | undefined,
  }
}

async function loadTenantTrackingConfig(tenantId: string): Promise<TenantTrackingConfig> {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { trackingConfig: true },
    })
    return normalizeTrackingConfig(tenant?.trackingConfig)
  } catch (e: unknown) {
    if (isMissingDbColumn(e, 'tracking_config')) {
      return normalizeTrackingConfig(null)
    }
    throw e
  }
}

function mapEventToDbRow(event: ProcessedEvent, tenantId: string, uploadId: string) {
  return {
    tenantId,
    uploadId,
    visitorKey: event.visitorKey,
    uuid: event.uuid || null,
    ip: event.ip || null,
    eventTs: event.eventTs,
    eventType: event.eventType || null,
    url: event.url || null,
    referrerUrl: event.referrerUrl || null,
    timeOnPageMs: event.timeOnPageMs || null,
    idleTimeMs: event.idleTimeMs || null,
    scrollPct: event.scrollPct || null,
    threshold: event.threshold || null,
    elementIdentifier: event.elementIdentifier || null,
    elementText: event.elementText || null,
    title: event.title || null,
    coordinates: event.coordinates ? (event.coordinates as any) : null,
    // rawJson intentionally omitted (identity extracted separately to save memory)
  }
}

/** After visitor profiles are upserted, persist upload stats and mark completed. */
async function finalizeCompletedUpload(args: {
  uploadId: string
  tenantId: string
  totalProcessed: number
  minTs: number
  maxTs: number
  uniqueVisitorsCount: number
  windowStart: Date
  windowEnd: Date
}) {
  const highIntentCount = await prisma.visitorProfile.count({
    where: {
      tenantId: args.tenantId,
      windowStart: args.windowStart,
      windowEnd: args.windowEnd,
      engagementScore: { gte: 6 },
    },
  })
  try {
    await prisma.upload.update({
      where: { id: args.uploadId },
      data: {
        status: 'completed',
        rowCount: args.totalProcessed,
        processedAt: new Date(),
        dataStartDate: new Date(args.minTs),
        dataEndDate: new Date(args.maxTs),
        totalEvents: args.totalProcessed,
        uniqueVisitors: args.uniqueVisitorsCount,
        highIntentCount,
        visitorProfileTotal: null,
        visitorProfileProcessed: null,
      },
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    if (
      msg.includes('visitor_profile_total') ||
      msg.includes('visitor_profile_processed') ||
      msg.includes('visitor_profile')
    ) {
      await prisma.upload.update({
        where: { id: args.uploadId },
        data: {
          status: 'completed',
          rowCount: args.totalProcessed,
          processedAt: new Date(),
          dataStartDate: new Date(args.minTs),
          dataEndDate: new Date(args.maxTs),
          totalEvents: args.totalProcessed,
          uniqueVisitors: args.uniqueVisitorsCount,
          highIntentCount,
        },
      })
    } else if (
      msg.includes('data_start_date') ||
      msg.includes('data_end_date') ||
      msg.includes('total_events') ||
      msg.includes('unique_visitors') ||
      msg.includes('high_intent_count')
    ) {
      console.warn(
        '[upload] DB missing upload stats columns; add prisma/add_upload_stats_columns.sql or run db push. Completing with minimal fields.'
      )
      await prisma.upload.update({
        where: { id: args.uploadId },
        data: {
          status: 'completed',
          rowCount: args.totalProcessed,
          processedAt: new Date(),
        },
      })
    } else {
      throw e
    }
  }
}

/**
 * Process CSV from stream - never loads full file into memory (avoids OOM on large files)
 */
export async function processCSVUploadFromStream(
  tenantId: string,
  uploadId: string,
  stream: ReadableStream<Uint8Array> | Readable
): Promise<{ rowCount: number; error?: string }> {
  // Accept both Web Streams (legacy) and Node.js Readables (from busboy - no buffering)
  const nodeStream: Readable = stream instanceof Readable ? stream : Readable.fromWeb(stream as any)
  return new Promise((resolve, reject) => {
    const visitorKeys = new Set<string>()
    // Store one compact identity record per visitor key (not the full CSV row)
    const identityByVisitor = new Map<string, IdentityData>()
    let minTs = Infinity
    let maxTs = -Infinity
    let totalProcessed = 0
    const batch: ProcessedEvent[] = []
    let insertChain = Promise.resolve() as Promise<void>

    const flushBatch = async (toInsert: ProcessedEvent[]) => {
      if (toInsert.length === 0) return
      await prisma.rawEvent.createMany({
        data: toInsert.map((e) => mapEventToDbRow(e, tenantId, uploadId)),
        skipDuplicates: false,
      })
      totalProcessed += toInsert.length
      await safeUploadSetProcessedRows(uploadId, totalProcessed)
    }

    let pixelFormatSaved = false
    const savePixelFormatOnce = (row: CSVRow) => {
      if (pixelFormatSaved) return
      const fmt = detectPixelFormatFromCsvRow(row)
      pixelFormatSaved = true
      void safeUploadSetPixelFormat(uploadId, fmt)
    }

    Papa.parse(nodeStream, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h: string) => h.trim(),
      step(results: { data: CSVRow | CSVRow[] }, parser: { pause: () => void; resume: () => void }) {
        const rows = Array.isArray(results.data) ? results.data : [results.data].filter(Boolean) as CSVRow[]
        for (const row of rows) {
          savePixelFormatOnce(row)
          const parsedEvents = parseRowsFromCsvRow(row)
          for (const event of parsedEvents) {
            // Strip rawJson from the event to save memory - identity captured separately
            event.rawJson = undefined
            batch.push(event)
            visitorKeys.add(event.visitorKey)
            // Capture identity only once per visitor (first row wins)
            if (event.visitorKey !== 'unknown' && !identityByVisitor.has(event.visitorKey)) {
              const id = extractIdentityFromRow(row)
              identityByVisitor.set(event.visitorKey, id)
            }
            const t = event.eventTs.getTime()
            if (t < minTs) minTs = t
            if (t > maxTs) maxTs = t
          }
        }
        if (batch.length >= 200) {
          const toInsert = batch.splice(0, 200)
          parser.pause()
          insertChain = insertChain.then(() => flushBatch(toInsert))
          insertChain.finally(() => parser.resume())
        }
      },
      async complete() {
        try {
          await insertChain
          if (batch.length > 0) await flushBatch(batch.splice(0))

          if (totalProcessed === 0) {
            const errorMsg = 'No valid events found. CSV had no rows with valid timestamps.'
            await prisma.upload.update({
              where: { id: uploadId },
              data: { status: 'error', error: errorMsg, rowCount: 0 },
            })
            resolve({ rowCount: 0, error: errorMsg })
            return
          }

          const realVisitorKeys = [...visitorKeys].filter(k => k !== 'unknown')
          console.log(`Inserted ${totalProcessed} events, ${realVisitorKeys.length} real visitors + ${visitorKeys.has('unknown') ? 1 : 0} unknown (streaming)`)

          const windowEnd = new Date(maxTs)
          const windowStart = new Date(Math.max(minTs, maxTs - 30 * 24 * 60 * 60 * 1000))

          const trackingConfig = await loadTenantTrackingConfig(tenantId)

          const profileTotal = realVisitorKeys.length
          if (profileTotal > 0) {
            await safeUploadSetVisitorProfileProgress(uploadId, 0, profileTotal)
          }
          for (let i = 0; i < realVisitorKeys.length; i++) {
            const visitorKey = realVisitorKeys[i]
            // Fetch events without rawJson (null in DB) to keep memory low
            const rawEvents = await prisma.rawEvent.findMany({
              where: { tenantId, uploadId, visitorKey },
              orderBy: { eventTs: 'asc' },
              select: RAW_EVENT_SELECT,
            })
            const events = rawEvents.map(mapRawEventToProcessed)
            await processVisitorProfile(
              tenantId,
              visitorKey,
              events,
              windowStart,
              windowEnd,
              identityByVisitor.get(visitorKey),
              trackingConfig
            )
            await safeUploadSetVisitorProfileProgress(uploadId, i + 1, profileTotal)
          }

          await finalizeCompletedUpload({
            uploadId,
            tenantId,
            totalProcessed,
            minTs,
            maxTs,
            uniqueVisitorsCount: realVisitorKeys.length,
            windowStart,
            windowEnd,
          })
          resolve({ rowCount: totalProcessed })
        } catch (err: any) {
          console.error('Error in CSV stream complete:', err)
          await prisma.upload.update({
            where: { id: uploadId },
            data: { status: 'error', error: err?.message || 'Processing failed' },
          })
          resolve({ rowCount: 0, error: err?.message })
        }
      },
      error(err: Error) {
        prisma.upload.update({
          where: { id: uploadId },
          data: { status: 'error', error: err?.message || 'Parse failed' },
        }).catch(() => {})
        reject(err)
      },
    })
  })
}

/**
 * Process CSV upload and create visitor profiles
 */
export async function processCSVUpload(
  tenantId: string,
  uploadId: string,
  csvContent: string
): Promise<{ rowCount: number; error?: string }> {
  try {
    // Parse CSV
    const parseResult = Papa.parse<CSVRow>(csvContent, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (header) => header.trim(),
    })

    if (parseResult.errors.length > 0) {
      console.warn('CSV parse errors:', parseResult.errors)
    }

    const rows = parseResult.data
    console.log(`Parsed ${rows.length} rows from CSV`)

    const visitorKeys = new Set<string>()
    const identityByVisitor = new Map<string, IdentityData>()
    let minTs = Infinity
    let maxTs = -Infinity
    let totalProcessed = 0
    const insertBatchSize = 200

    // Process and insert in chunks - never hold full processedEvents in memory
    let pixelFormatSaved = false
    for (let i = 0; i < rows.length; i += insertBatchSize) {
      const chunk = rows.slice(i, i + insertBatchSize)
      const batch: ProcessedEvent[] = []
      for (const row of chunk) {
        if (!pixelFormatSaved && row && Object.keys(row).length > 0) {
          const fmt = detectPixelFormatFromCsvRow(row)
          pixelFormatSaved = true
          await safeUploadSetPixelFormat(uploadId, fmt)
        }
        const parsedEvents = parseRowsFromCsvRow(row)
        for (const event of parsedEvents) {
          event.rawJson = undefined // don't store full row in DB
          batch.push(event)
          visitorKeys.add(event.visitorKey)
          if (event.visitorKey !== 'unknown' && !identityByVisitor.has(event.visitorKey)) {
            identityByVisitor.set(event.visitorKey, extractIdentityFromRow(row))
          }
          const t = event.eventTs.getTime()
          if (t < minTs) minTs = t
          if (t > maxTs) maxTs = t
        }
      }
      if (batch.length === 0) continue
      totalProcessed += batch.length

      await prisma.rawEvent.createMany({
        data: batch.map((event) => mapEventToDbRow(event, tenantId, uploadId)),
        skipDuplicates: false,
      })
      await safeUploadSetProcessedRows(uploadId, totalProcessed)
    }

    const realVisitorKeys = [...visitorKeys].filter(k => k !== 'unknown')
    console.log(`Inserted ${totalProcessed} events, ${realVisitorKeys.length} real visitors (non-streaming)`)

    if (totalProcessed === 0) {
      const errorMsg = `No valid events found. CSV had ${rows.length} rows but none had valid timestamps. Check that CSV has a timestamp column.`
      await prisma.upload.update({
        where: { id: uploadId },
        data: { status: 'error', error: errorMsg, rowCount: 0 },
      })
      return { rowCount: 0, error: errorMsg }
    }

    const windowEnd = new Date(maxTs)
    const windowStart = new Date(Math.max(minTs, maxTs - 30 * 24 * 60 * 60 * 1000))

    const trackingConfig = await loadTenantTrackingConfig(tenantId)

    // Build visitor profiles one at a time; skip 'unknown' (would load ALL unidentified events at once)
    const profileTotal = realVisitorKeys.length
    if (profileTotal > 0) {
      await safeUploadSetVisitorProfileProgress(uploadId, 0, profileTotal)
    }
    for (let i = 0; i < realVisitorKeys.length; i++) {
      const visitorKey = realVisitorKeys[i]
      const rawEvents = await prisma.rawEvent.findMany({
        where: { tenantId, uploadId, visitorKey },
        orderBy: { eventTs: 'asc' },
        select: RAW_EVENT_SELECT,
      })
      const events = rawEvents.map(mapRawEventToProcessed)
      await processVisitorProfile(
        tenantId,
        visitorKey,
        events,
        windowStart,
        windowEnd,
        identityByVisitor.get(visitorKey),
        trackingConfig
      )
      await safeUploadSetVisitorProfileProgress(uploadId, i + 1, profileTotal)
    }

    await finalizeCompletedUpload({
      uploadId,
      tenantId,
      totalProcessed,
      minTs,
      maxTs,
      uniqueVisitorsCount: realVisitorKeys.length,
      windowStart,
      windowEnd,
    })

    return { rowCount: totalProcessed }
  } catch (error: any) {
    console.error('Error processing CSV:', error)
    await prisma.upload.update({
      where: { id: uploadId },
      data: {
        status: 'error',
        error: error.message || 'Unknown error',
      },
    })
    return { rowCount: 0, error: error.message }
  }
}

/**
 * Process visitor profile from events
 */
async function processVisitorProfile(
  tenantId: string,
  visitorKey: string,
  events: ProcessedEvent[],
  windowStart: Date,
  windowEnd: Date,
  preExtractedIdentity?: IdentityData,
  trackingConfig?: TenantTrackingConfig
): Promise<void> {
  if (events.length === 0) return

  const config = trackingConfig ?? normalizeTrackingConfig(null)

  let existingProfile: { identity: unknown } | null = null
  if (!preExtractedIdentity) {
    existingProfile = await prisma.visitorProfile.findUnique({
      where: {
        tenantId_windowStart_windowEnd_visitorKey: {
          tenantId,
          windowStart,
          windowEnd,
          visitorKey,
        },
      },
      select: { identity: true },
    })
  }

  // Group into sessions
  const sessions = groupIntoSessions(events)

  // Calculate aggregates
  const sortedEvents = [...events].sort((a, b) => a.eventTs.getTime() - b.eventTs.getTime())
  const firstSeenAt = sortedEvents[0].eventTs
  const lastSeenAt = sortedEvents[sortedEvents.length - 1].eventTs

  const pageViews = events.filter((e) => {
    const et = (e.eventType || '').toLowerCase()
    return et.includes('page_view') || et.includes('pageview') || et === 'view'
  }).length

  const uniquePages = new Set(events.map((e) => e.url).filter(Boolean)).size

  const totalTimeOnPageMs = computeTotalTimeOnPageMs(events, sessions)

  const avgTimeOnPageMs = pageViews > 0 ? totalTimeOnPageMs / pageViews : 0

  const maxScrollPct = Math.max(
    ...events.map((e) => e.scrollPct || 0),
    0
  )

  // Calculate flags (per-client key page & CTA rules)
  const visitedKeyPage = events.some((e) => matchesKeyPage(e.url, config))
  const ctaClicked = events.some((e) => matchesCtaEvent(e, config))
  const exitIntentTriggered = events.some((e) => isExitIntent(e.eventType))
  const videoEngaged = events.some((e) => isVideoEngaged(e.eventType))

  const sparseBehavior = eventsHaveSparseBehavioralSignals(events)

  const flags: VisitorFlags = {
    is_repeat_visitor: sessions.length >= 2,
    high_attention: sparseBehavior
      ? uniquePages >= 3 || sessions.length >= 2
      : totalTimeOnPageMs >= 60000,
    visited_key_page: visitedKeyPage,
    cta_clicked: ctaClicked,
    exit_intent_triggered: exitIntentTriggered,
    video_engaged: videoEngaged,
  }

  // Calculate score
  const score = sparseBehavior
    ? calculateEngagementScoreSparseBehavior({
        visitsCount: sessions.length,
        totalTimeOnPageMs,
        maxScrollPercentage: maxScrollPct,
        visitedKeyPage,
        ctaClicked,
        exitIntentTriggered,
        videoEngaged,
        uniquePagesCount: uniquePages,
        totalEvents: events.length,
      })
    : calculateEngagementScore({
        visitsCount: sessions.length,
        totalTimeOnPageMs,
        maxScrollPercentage: maxScrollPct,
        visitedKeyPage,
        ctaClicked,
        exitIntentTriggered,
        videoEngaged,
      })

  const segment = getEngagementSegment(score)

  // Extract identity overlay (use pre-extracted compact record; fallback to rawJson for legacy calls)
  const identity: any = {}
  const id = preExtractedIdentity ?? (events[0]?.rawJson ? extractIdentityFromRow(events[0].rawJson as CSVRow) : undefined)

  if (id) {
    if (id.firstName)      identity.firstName      = id.firstName
    if (id.lastName)       identity.lastName       = id.lastName
    if (id.companyName)    identity.companyName    = id.companyName
    if (id.companyDomain)  identity.companyDomain  = id.companyDomain
    if (id.jobTitle)       identity.jobTitle       = id.jobTitle
    if (id.seniorityLevel) identity.seniorityLevel = id.seniorityLevel
    if (id.businessEmail)  identity.businessEmail  = id.businessEmail
    if (id.phone)          identity.phone          = id.phone
    if (id.mobilePhone)    identity.mobilePhone    = id.mobilePhone
    if (id.address)        identity.address        = id.address
    if (id.companyAddress) identity.companyAddress = id.companyAddress
    if (id.city)           identity.city           = id.city
    if (id.state)          identity.state          = id.state
    if (id.zip)            identity.zip            = id.zip
  }

  const identityPayload =
    Object.keys(identity).length > 0
      ? identity
      : existingProfile?.identity && typeof existingProfile.identity === 'object'
        ? existingProfile.identity
        : null

  // Get geo: prefer address geocoding when sheet has address (accurate map), else IP-based
  let geo: { lat?: number; lng?: number; city?: string; region?: string; country?: string } = {}
  const addressFromSheet  = id?.address || id?.companyAddress
  const cityFromSheet     = id?.city
  const stateFromSheet    = id?.state
  const zipFromSheet      = id?.zip
  const countryFromSheet  = id?.country || 'US'
  const hasAddressFromSheet = !!(addressFromSheet || cityFromSheet || stateFromSheet || zipFromSheet)

  if (hasAddressFromSheet) {
    // Prefer address geocoding when sheet has address - map shows accurate location
    const { geocodeAddress } = await import('./geo')
    const addressGeo = await geocodeAddress(
      addressFromSheet || '',
      cityFromSheet || '',
      stateFromSheet || '',
      zipFromSheet || '',
      countryFromSheet || 'US'
    )
    if (addressGeo?.lat && addressGeo?.lng) {
      geo = {
        lat: addressGeo.lat,
        lng: addressGeo.lng,
        city: addressGeo.city || cityFromSheet || undefined,
        region: addressGeo.region || stateFromSheet || undefined,
        country: addressGeo.country || countryFromSheet || undefined,
      }
      console.log(`Using address geocode for visitor ${visitorKey}:`, geo)
    }
  }

  if (!geo.lat || !geo.lng) {
    // Fallback: IP-based geo or event coordinates
    const eventWithGeo = events.find((e) => e.coordinates || e.ip)
    if (eventWithGeo) {
      if (eventWithGeo.coordinates) {
        geo = {
          lat: eventWithGeo.coordinates.lat,
          lng: eventWithGeo.coordinates.lng,
        }
        console.log(`Using event coordinates for visitor ${visitorKey}:`, geo)
      } else if (eventWithGeo.ip) {
        const geoData = await getGeoLocation(eventWithGeo.ip)
        if (geoData) {
          geo = geoData
          console.log(`Using IP geo for visitor ${visitorKey}:`, geo)
        }
      }
    }
  }

  // Upsert visitor profile
  await prisma.visitorProfile.upsert({
    where: {
      tenantId_windowStart_windowEnd_visitorKey: {
        tenantId,
        windowStart,
        windowEnd,
        visitorKey,
      },
    },
    update: {
      lastSeenAt,
      visitsCount: sessions.length,
      totalEvents: events.length,
      pageViews,
      uniquePagesCount: uniquePages,
      totalTimeOnPageMs,
      avgTimeOnPageMs,
      maxScrollPercentage: maxScrollPct,
      flags: flags as any,
      engagementScore: score,
      engagementSegment: segment,
      lat: geo.lat || null,
      lng: geo.lng || null,
      city: geo.city || null,
      region: geo.region || null,
      country: geo.country || null,
      identity: identityPayload,
      updatedAt: new Date(),
    },
    create: {
      tenantId,
      windowStart,
      windowEnd,
      visitorKey,
      firstSeenAt,
      lastSeenAt,
      visitsCount: sessions.length,
      totalEvents: events.length,
      pageViews,
      uniquePagesCount: uniquePages,
      totalTimeOnPageMs,
      avgTimeOnPageMs,
      maxScrollPercentage: maxScrollPct,
      flags: flags as any,
      engagementScore: score,
      engagementSegment: segment,
      lat: geo.lat || null,
      lng: geo.lng || null,
      city: geo.city || null,
      region: geo.region || null,
      country: geo.country || null,
      identity: identityPayload,
    },
  })
}

/**
 * Recompute visitor profiles after tracking rules change (uses stored raw events).
 */
export async function rebuildTenantVisitorProfiles(
  tenantId: string
): Promise<{ rebuilt: number; uploads: number }> {
  const trackingConfig = await loadTenantTrackingConfig(tenantId)
  const uploads = await prisma.upload.findMany({
    where: { tenantId, status: 'completed' },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })

  let rebuilt = 0
  for (const upload of uploads) {
    const bounds = await prisma.rawEvent.aggregate({
      where: { tenantId, uploadId: upload.id },
      _min: { eventTs: true },
      _max: { eventTs: true },
    })
    if (!bounds._min.eventTs || !bounds._max.eventTs) continue

    const minTs = bounds._min.eventTs.getTime()
    const maxTs = bounds._max.eventTs.getTime()
    const windowEnd = new Date(maxTs)
    const windowStart = new Date(Math.max(minTs, maxTs - 30 * 24 * 60 * 60 * 1000))

    const keyRows = await prisma.rawEvent.findMany({
      where: { tenantId, uploadId: upload.id, visitorKey: { not: 'unknown' } },
      distinct: ['visitorKey'],
      select: { visitorKey: true },
    })

    for (const { visitorKey } of keyRows) {
      const rawEvents = await prisma.rawEvent.findMany({
        where: { tenantId, uploadId: upload.id, visitorKey },
        orderBy: { eventTs: 'asc' },
        select: RAW_EVENT_SELECT,
      })
      if (rawEvents.length === 0) continue
      await processVisitorProfile(
        tenantId,
        visitorKey,
        rawEvents.map(mapRawEventToProcessed),
        windowStart,
        windowEnd,
        undefined,
        trackingConfig
      )
      rebuilt++
    }
  }

  return { rebuilt, uploads: uploads.length }
}

