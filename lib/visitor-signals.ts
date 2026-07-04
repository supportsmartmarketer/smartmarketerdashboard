import {
  eventsHaveSparseBehavioralSignals,
  isExitIntent,
  isVideoEngaged,
  type VisitorFlags,
} from './scoring'
import {
  matchesCtaEvent,
  matchesKeyPage,
  type TenantTrackingConfig,
} from './tenant-tracking-config'

export interface SignalEvent {
  eventTs: Date
  eventType?: string | null
  url?: string | null
  timeOnPageMs?: number | null
  scrollPct?: number | null
  elementIdentifier?: string | null
  elementText?: string | null
  title?: string | null
}

function groupIntoSessions(events: SignalEvent[]): SignalEvent[][] {
  if (events.length === 0) return []

  const sorted = [...events].sort((a, b) => a.eventTs.getTime() - b.eventTs.getTime())
  const sessions: SignalEvent[][] = []
  let currentSession: SignalEvent[] = [sorted[0]]

  for (let i = 1; i < sorted.length; i++) {
    const gapMinutes = (sorted[i].eventTs.getTime() - sorted[i - 1].eventTs.getTime()) / (1000 * 60)
    if (gapMinutes <= 30) {
      currentSession.push(sorted[i])
    } else {
      sessions.push(currentSession)
      currentSession = [sorted[i]]
    }
  }

  if (currentSession.length > 0) sessions.push(currentSession)
  return sessions
}

function inferSessionDurationMs(session: SignalEvent[]): number {
  if (session.length === 0) return 0
  if (session.length === 1) return Number(session[0].timeOnPageMs) || 0
  const start = session[0].eventTs.getTime()
  const end = session[session.length - 1].eventTs.getTime()
  return Math.min(30 * 60 * 1000, Math.max(0, end - start))
}

/** V4-friendly dwell: explicit timeOnPage per session, else infer from event timestamps. */
export function computeTotalTimeOnPageMs(events: SignalEvent[]): number {
  const sessions = groupIntoSessions(events)
  let total = 0
  for (const session of sessions) {
    const explicit = session.map((e) => Number(e.timeOnPageMs) || 0).filter((t) => t > 0)
    if (explicit.length > 0) {
      total += Math.max(...explicit)
    } else {
      total += inferSessionDurationMs(session)
    }
  }
  if (total === 0 && events.length >= 2) {
    return inferSessionDurationMs(
      [...events].sort((a, b) => a.eventTs.getTime() - b.eventTs.getTime())
    )
  }
  return total
}

/**
 * Compute filter flags from raw events in the dashboard calendar window,
 * using the tenant's current key-page / CTA rules (V4-first).
 */
export function computeVisitorWindowSignals(
  events: SignalEvent[],
  config: TenantTrackingConfig
): {
  flags: VisitorFlags
  totalTimeOnPageMs: number
  maxScrollPercentage: number
  visitsCount: number
} {
  if (events.length === 0) {
    return {
      flags: {
        is_repeat_visitor: false,
        high_attention: false,
        visited_key_page: false,
        cta_clicked: false,
        exit_intent_triggered: false,
        video_engaged: false,
      },
      totalTimeOnPageMs: 0,
      maxScrollPercentage: 0,
      visitsCount: 0,
    }
  }

  const sessions = groupIntoSessions(events)
  const totalTimeOnPageMs = computeTotalTimeOnPageMs(events)
  const maxScrollPercentage = Math.max(...events.map((e) => Number(e.scrollPct) || 0), 0)
  const uniquePages = new Set(events.map((e) => e.url).filter(Boolean)).size
  const sparseBehavior = eventsHaveSparseBehavioralSignals(
    events.map((e) => ({
      timeOnPageMs: e.timeOnPageMs ?? undefined,
      scrollPct: e.scrollPct ?? undefined,
      eventType: e.eventType ?? undefined,
    }))
  )

  const visitedKeyPage = events.some((e) => matchesKeyPage(e.url, config))
  const ctaClicked = events.some((e) => matchesCtaEvent(e, config))
  const exitIntentTriggered = events.some((e) => isExitIntent(e.eventType))
  const videoEngaged = events.some((e) => isVideoEngaged(e.eventType))

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

  return {
    flags,
    totalTimeOnPageMs,
    maxScrollPercentage,
    visitsCount: sessions.length,
  }
}

export function groupEventsByVisitorKey<T extends { visitorKey: string }>(
  rows: T[]
): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const row of rows) {
    const list = map.get(row.visitorKey)
    if (list) list.push(row)
    else map.set(row.visitorKey, [row])
  }
  return map
}
