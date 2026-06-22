export interface VisitorFlags {
  is_repeat_visitor: boolean
  high_attention: boolean
  visited_key_page: boolean
  cta_clicked: boolean
  exit_intent_triggered: boolean
  video_engaged: boolean
}

export interface ScoringInput {
  visitsCount: number
  totalTimeOnPageMs: number
  maxScrollPercentage: number
  visitedKeyPage: boolean
  ctaClicked: boolean
  exitIntentTriggered: boolean
  videoEngaged: boolean
}

/**
 * Calculate engagement score based on rules
 * +2 repeat visits
 * +2 total_time_on_page >= 60s
 * +1 max_scroll >= 50%
 * +2 visited_key_page
 * +3 cta_clicked
 * +3 exit_intent_triggered
 * +2 video_engaged
 */
export function calculateEngagementScore(input: ScoringInput): number {
  let score = 0

  if (input.visitsCount >= 2) score += 2
  if (input.totalTimeOnPageMs >= 60000) score += 2
  if (input.maxScrollPercentage >= 50) score += 1
  if (input.visitedKeyPage) score += 2
  if (input.ctaClicked) score += 3
  if (input.exitIntentTriggered) score += 3
  if (input.videoEngaged) score += 2

  return score
}

/** V4-style rows often lack time-on-page / scroll; approximate “depth” from pages + volume. */
export interface ScoringInputSparseBehavior extends ScoringInput {
  uniquePagesCount: number
  totalEvents: number
}

export function calculateEngagementScoreSparseBehavior(input: ScoringInputSparseBehavior): number {
  let score = 0
  if (input.visitsCount >= 2) score += 2
  if (input.uniquePagesCount >= 3) score += 2
  else if (input.uniquePagesCount >= 2) score += 1
  if (input.visitedKeyPage) score += 2
  if (input.ctaClicked) score += 3
  if (input.exitIntentTriggered) score += 3
  if (input.videoEngaged) score += 2
  if (input.totalEvents >= 4) score += 1
  if (input.totalEvents >= 8) score += 1
  return Math.min(15, score)
}

type SparseEventShape = {
  timeOnPageMs?: number
  scrollPct?: number | null
  eventType?: string | null
}

/**
 * True when exported rows have no dwell/scroll signals and look like URL-only hits (typical V4).
 */
export function eventsHaveSparseBehavioralSignals(events: SparseEventShape[]): boolean {
  if (events.length === 0) return false
  const noDwellOrScroll = events.every(
    (e) =>
      !e.timeOnPageMs &&
      (e.scrollPct == null || e.scrollPct === 0)
  )
  if (!noDwellOrScroll) return false
  return events.every((e) => {
    const et = (e.eventType || '').toLowerCase()
    return (
      !et ||
      et.includes('page_view') ||
      et.includes('pageview') ||
      et === 'view'
    )
  })
}

/**
 * Get engagement segment from score
 */
export function getEngagementSegment(score: number): string {
  if (score >= 9) return 'Action'
  if (score >= 6) return 'HighIntent'
  if (score >= 3) return 'Researcher'
  return 'Casual'
}

/**
 * Check if URL is a key page
 */
export function isKeyPage(url: string | null | undefined): boolean {
  if (!url) return false
  const lowerUrl = url.toLowerCase()
  const keyPageKeywords = ['pricing', 'contact', 'book', 'demo', 'thank-you', 'checkout', 'schedule']
  return keyPageKeywords.some((keyword) => lowerUrl.includes(keyword))
}

/**
 * Check if element identifier indicates a CTA click
 */
export function isCTAClick(elementIdentifier: string | null | undefined, url: string | null | undefined): boolean {
  if (!elementIdentifier && !url) return false
  const combined = `${elementIdentifier || ''} ${url || ''}`.toLowerCase()
  const ctaKeywords = ['contact', 'pricing', 'book', 'schedule', 'demo', 'apply', 'lead', 'call', 'button', 'cta']
  return ctaKeywords.some((keyword) => combined.includes(keyword))
}

/** V4 EVENTS column uses event types like form_submit */
export function isFormSubmit(eventType: string | null | undefined): boolean {
  if (!eventType) return false
  const lower = eventType.toLowerCase()
  return lower.includes('form_submit') || lower === 'formsubmit'
}

/**
 * Check if event type indicates exit intent
 */
export function isExitIntent(eventType: string | null | undefined): boolean {
  if (!eventType) return false
  const lower = eventType.toLowerCase()
  return lower.includes('exit') || lower.includes('intent') || lower.includes('leave')
}

/**
 * Check if event type indicates video engagement
 */
export function isVideoEngaged(eventType: string | null | undefined): boolean {
  if (!eventType) return false
  const lower = eventType.toLowerCase()
  return lower.includes('video') || lower.includes('play') || lower.includes('watch')
}

