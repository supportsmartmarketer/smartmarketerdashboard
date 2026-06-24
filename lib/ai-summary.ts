import type { Prisma } from '@prisma/client'
import OpenAI from 'openai'
import type { PixelReportingContext } from './ai-summary-pixel-context'
import { prisma } from './prisma'

function asJson(v: unknown): Prisma.InputJsonValue {
  return v as Prisma.InputJsonValue
}

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    })
  : null

export interface DashboardMetrics {
  totalVisitors: number
  engagedVisitors: number
  repeatVisitors: number
  highIntentVisitors: number
  newVisitors: number
  returningVisitors: number
  engagementBreakdown: {
    Casual: number
    Researcher: number
    HighIntent: number
    Action: number
  }
  topUrls: Array<{ url: string; visits: number }>
  topEvents: Array<{ eventType: string; count: number }>
  highIntentVisitorsList: Array<{
    visitorKey: string
    score: number
    visits: number
    timeOnPage: number
  }>
}

export type ObservationConfidence = 'High' | 'Medium' | 'Low'

export interface KeyObservationItem {
  observation: string
  confidence: ObservationConfidence
}

export interface PriorityAction {
  action: string
  estimatedImpact: string
  urgency: string
}

export interface AISummaryPayload {
  executiveSummary: string
  keyObservations: KeyObservationItem[]
  recommendedActions: string[]
  notableSegments: Array<{ segment: string; description: string }>
  priorityAction: PriorityAction | null
  revenueInsights: string[]
}

export function normalizeKeyObservations(data: unknown): KeyObservationItem[] {
  if (!Array.isArray(data)) return []
  return data.map((item) => {
    if (typeof item === 'string') {
      return { observation: item, confidence: 'Medium' as const }
    }
    if (item && typeof item === 'object' && 'observation' in item) {
      const o = item as { observation?: string; confidence?: string }
      const c = (o.confidence || 'Medium').trim()
      const confidence: ObservationConfidence =
        c === 'High' || c === 'Low' || c === 'Medium' ? c : 'Medium'
      return { observation: String(o.observation ?? ''), confidence }
    }
    return { observation: '', confidence: 'Medium' as const }
  })
}

export function normalizePriorityAction(data: unknown): PriorityAction | null {
  if (!data || typeof data !== 'object') return null
  const p = data as Record<string, unknown>
  const action = p.action
  if (typeof action !== 'string' || !action.trim()) return null
  return {
    action: action.trim(),
    estimatedImpact: String(p.estimatedImpact ?? ''),
    urgency: String(p.urgency ?? ''),
  }
}

export function normalizeRevenueInsights(data: unknown): string[] {
  if (!Array.isArray(data)) return []
  return data.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
}

export function normalizeRecommendedActions(data: unknown): string[] {
  if (!Array.isArray(data)) return []
  return data
    .map((item) => {
      if (typeof item === 'string') return item.trim()
      if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>
        if (typeof o.action === 'string') return o.action.trim()
        if (typeof o.recommendation === 'string') return o.recommendation.trim()
        if (typeof o.text === 'string') return o.text.trim()
      }
      return ''
    })
    .filter((s) => s.length > 0)
}

export function normalizeNotableSegments(
  data: unknown
): Array<{ segment: string; description: string }> {
  if (!Array.isArray(data)) return []
  return data
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const o = item as Record<string, unknown>
      const segment =
        typeof o.segment === 'string'
          ? o.segment.trim()
          : typeof o.name === 'string'
            ? o.name.trim()
            : ''
      const description =
        typeof o.description === 'string'
          ? o.description.trim()
          : typeof o.summary === 'string'
            ? o.summary.trim()
            : ''
      if (!segment && !description) return null
      return { segment: segment || 'Segment', description }
    })
    .filter((s): s is { segment: string; description: string } => s !== null)
}

/**
 * Generate AI summary for tenant and time window
 */
export async function generateAISummary(
  tenantId: string,
  windowStart: Date,
  windowEnd: Date,
  metrics: DashboardMetrics,
  roiContext?: unknown,
  pixelReporting?: PixelReportingContext | null
): Promise<AISummaryPayload> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set')
  }

  const inputData = {
    metrics: {
      totalVisitors: metrics.totalVisitors,
      engagedVisitors: metrics.engagedVisitors,
      repeatVisitors: metrics.repeatVisitors,
      highIntentVisitors: metrics.highIntentVisitors,
      newVsReturning: {
        new: metrics.newVisitors,
        returning: metrics.returningVisitors,
      },
      engagementBreakdown: metrics.engagementBreakdown,
      topUrls: metrics.topUrls.slice(0, 10),
      topEvents: metrics.topEvents.slice(0, 10),
      highIntentCount: metrics.highIntentVisitorsList.length,
    },
  }

  const roiBlock =
    roiContext != null && typeof roiContext === 'object' && Object.keys(roiContext as object).length > 0
      ? `

Revenue recovery / business context (from the client's ROI calculator — use real numbers when referencing opportunity):
${JSON.stringify(roiContext, null, 2)}
`
      : ''

  const pixelBlock =
    pixelReporting != null
      ? `
PIXEL EXPORT & SIGNAL QUALITY CONTEXT (critical — obey these constraints; this reflects what landed in CSV uploads, not live pixel internals):
${JSON.stringify(pixelReporting, null, 2)}

Instruction rules tied to pixelReporting:
• If signalDepth is "sparse" OR dwellOrScrollFraction is very low (<~0.1) with high pageViewDominanceFraction: Do NOT prescribe tactics that require scroll-percent thresholds, granular active dwell seconds, precise click-coordinate analysis, exit-intent moment tracking, multi-step granular heatmaps, or video watch-completion detail unless metrics.topEvents and dwellOrScrollFraction clearly support those signals.
• If signalDepth is "sparse" and pixelFormatsPresent includes "v4" (especially when v3 absent): Pivot recommendations toward identity-resolution value: prioritized outreach cohorts keyed off URLs that actually appeared (topUrls), repeat visitors, geography/segment mixes, and "visitors who hit /pricing/, /contact/, etc." using COUNTS ONLY from the dashboard data. Example framing: prioritize the cohort of contacts who landed on URLs you cite from topUrls — NEVER paste names, emails, or phone numbers even if you infer them existed.
• If profilesWithResolvableContactHints is sizeable while signals are sparse: Emphasize list-building and sequences for that cohort size WITHOUT revealing PII. Say "contacts with enrichment/identity cues" rather than implying you saw full contact rows.
• If signalDepth is "mixed" because both v3 and v4 uploads exist: Acknowledge segment noise; differentiate advice that applies globally vs subsets where deeper behavior may exist.
• If signalDepth is "rich": You may reference scroll/dwell/key-page funnels WHEN supported by aggregates — still no invented micro-behavior absent from metrics.

(use placeholder reasoning only inside examples; cite real URLs from topUrls/topEvents in your actual bullets)

`
      : ''

  const prompt = `You are analyzing visitor behavior data for a client dashboard. Generate a concise executive summary and actionable insights.

Data:
${JSON.stringify(inputData, null, 2)}
${roiBlock}
${pixelBlock}

Generate:
1. Executive Summary (3-5 sentences): Overview of visitor behavior, engagement trends, and key highlights. If ROI context is provided, tie traffic and segments to revenue language where appropriate.

2. Key Observations (3-5 items): Notable patterns, anomalies, or trends. Each item MUST include a confidence level: High, Medium, or Low (based on strength of evidence in the data).

3. Recommended Actions (3-5 bullet points): Specific steps. Each must make clear WHO to target, WHAT to do or say, WHY (cite metrics or URLs), and estimated IMPACT when possible. When pixelReporting.signalDepth is "sparse" and profilesWithResolvableContactHints is greater than zero, include at least one action that leverages that cohort size plus concrete URLs from metrics.topUrls (never PII fields). If ROI context exists, reference dollar or pipeline ranges from it.

4. Notable Segments (2-4 items): Interesting visitor segments. When behavioral depth is sparse, prefer segments anchored on reachable URLs, repeat visitation, or enrichment cohort counts rather than implied scroll/session micro-states absent from the ingest.

5. priorityAction: One object with action (string), estimatedImpact (string, can be a range), urgency (e.g. "This Week"). If roiContext is present, flag the single highest-leverage action as the priority and prefix the action text with "🔥 Priority #1: ". If roiContext is absent, still pick the strongest action from behavior data.

6. revenueInsights: 2-4 short strings with revenue or pipeline angles — ONLY if roiContext was provided; otherwise return an empty array.

7. Flag unusual scroll drop-offs ONLY when dwellOrScrollFraction in pixel context suggests scroll/dwell signals are reliable enough to mention; otherwise omit scroll-specific diagnostics.

Return as JSON:
{
  "executiveSummary": "...",
  "keyObservations": [
    { "observation": "...", "confidence": "High" }
  ],
  "recommendedActions": ["...", "..."],
  "notableSegments": [
    {"segment": "...", "description": "..."}
  ],
  "priorityAction": { "action": "...", "estimatedImpact": "...", "urgency": "..." },
  "revenueInsights": ["..."]
}

Do not include any PII (emails, phone numbers, names) in the output. You MAY reference cohort sizes ("N visitors with enrichment cues") derived from profilesWithResolvableContactHints. Focus on behavioral patterns supported by metrics and on URL-level intent where depth is lacking.`

  try {
    const completion = await openai!.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'You are a data analyst providing insights on visitor behavior. Always return valid JSON. Do not output PII (names, emails, phones). Respect pixel REPORTING constraints in the prompt: sparse V4-style feeds require identity/url/repeat-led guidance, not scroll micro-optimization fantasies.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.7,
    })

    const content = completion.choices[0]?.message?.content
    if (!content) {
      throw new Error('No response from OpenAI')
    }

    const parsed = JSON.parse(content)

    return {
      executiveSummary: parsed.executiveSummary || '',
      keyObservations: normalizeKeyObservations(parsed.keyObservations),
      recommendedActions: normalizeRecommendedActions(parsed.recommendedActions),
      notableSegments: normalizeNotableSegments(parsed.notableSegments),
      priorityAction: normalizePriorityAction(parsed.priorityAction),
      revenueInsights: normalizeRevenueInsights(parsed.revenueInsights),
    }
  } catch (error: unknown) {
    console.error('Error generating AI summary:', error)
    const msg = error instanceof Error ? error.message : 'Unknown error'
    throw new Error(`Failed to generate AI summary: ${msg}`)
  }
}

function toApiShape(
  row: {
    id: string
    executiveSummary: string
    keyObservations: unknown
    recommendedActions: unknown
    notableSegments: unknown
    priorityAction: unknown
    revenueInsights: unknown
    createdAt: Date
  }
) {
  return {
    id: row.id,
    executiveSummary: row.executiveSummary,
    keyObservations: normalizeKeyObservations(row.keyObservations),
    recommendedActions: normalizeRecommendedActions(row.recommendedActions),
    notableSegments: normalizeNotableSegments(row.notableSegments),
    priorityAction: normalizePriorityAction(row.priorityAction),
    revenueInsights: normalizeRevenueInsights(row.revenueInsights),
    createdAt: row.createdAt,
  }
}

/**
 * Get or generate AI summary for tenant
 */
export async function getOrGenerateSummary(
  tenantId: string,
  windowStart: Date,
  windowEnd: Date,
  metrics: DashboardMetrics,
  forceRegenerate: boolean = false,
  roiContext?: unknown,
  pixelReporting?: PixelReportingContext | null
) {
  if (!forceRegenerate) {
    const existing = await prisma.tenantSummary.findUnique({
      where: {
        tenantId_windowStart_windowEnd: {
          tenantId,
          windowStart,
          windowEnd,
        },
      },
    })

    if (existing) {
      return toApiShape(existing)
    }
  }

  const summary = await generateAISummary(
    tenantId,
    windowStart,
    windowEnd,
    metrics,
    roiContext,
    pixelReporting
  )

  const saved = await prisma.tenantSummary.upsert({
    where: {
      tenantId_windowStart_windowEnd: {
        tenantId,
        windowStart,
        windowEnd,
      },
    },
    update: {
      executiveSummary: summary.executiveSummary,
      keyObservations: asJson(summary.keyObservations),
      recommendedActions: asJson(summary.recommendedActions),
      notableSegments: asJson(summary.notableSegments),
      priorityAction: asJson(summary.priorityAction),
      revenueInsights: asJson(summary.revenueInsights),
    },
    create: {
      tenantId,
      windowStart,
      windowEnd,
      executiveSummary: summary.executiveSummary,
      keyObservations: asJson(summary.keyObservations),
      recommendedActions: asJson(summary.recommendedActions),
      notableSegments: asJson(summary.notableSegments),
      priorityAction: asJson(summary.priorityAction),
      revenueInsights: asJson(summary.revenueInsights),
    },
  })

  return toApiShape(saved)
}
