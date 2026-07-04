import { isFormSubmit } from './scoring'

export interface TenantTrackingConfig {
  /** URL path fragments or full URLs, e.g. /pricing, contact, /request-demo */
  keyPagePatterns: string[]
  /** URLs or path fragments that count as a CTA click */
  ctaUrlPatterns: string[]
  /** Link/button text phrases, e.g. "request demo now" */
  ctaPhrasePatterns: string[]
}

export const DEFAULT_KEY_PAGE_PATTERNS = [
  'pricing',
  'contact',
  'book',
  'demo',
  'thank-you',
  'checkout',
  'schedule',
]

export const DEFAULT_CTA_URL_PATTERNS = [
  'contact',
  'pricing',
  'book',
  'schedule',
  'demo',
  'apply',
  'lead',
]

export const DEFAULT_CTA_PHRASE_PATTERNS = [
  'contact',
  'book',
  'schedule',
  'demo',
  'apply',
  'get quote',
  'request demo',
]

function normalizePattern(value: string): string {
  return value.trim().toLowerCase()
}

/** Split textarea / comma-separated input into trimmed non-empty patterns */
export function parsePatternList(input: string): string[] {
  return input
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function patternsToTextarea(patterns: string[]): string {
  return patterns.join('\n')
}

export function normalizeTrackingConfig(raw: unknown): TenantTrackingConfig {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const asList = (v: unknown): string[] => {
    if (!Array.isArray(v)) return []
    return v
      .map((x) => (typeof x === 'string' ? x.trim() : ''))
      .filter(Boolean)
  }
  return {
    keyPagePatterns: asList(obj.keyPagePatterns),
    ctaUrlPatterns: asList(obj.ctaUrlPatterns),
    ctaPhrasePatterns: asList(obj.ctaPhrasePatterns),
  }
}

export function effectiveKeyPagePatterns(config: TenantTrackingConfig): string[] {
  return config.keyPagePatterns.length > 0 ? config.keyPagePatterns : DEFAULT_KEY_PAGE_PATTERNS
}

export function effectiveCtaUrlPatterns(config: TenantTrackingConfig): string[] {
  return config.ctaUrlPatterns.length > 0 ? config.ctaUrlPatterns : DEFAULT_CTA_URL_PATTERNS
}

export function effectiveCtaPhrasePatterns(config: TenantTrackingConfig): string[] {
  return config.ctaPhrasePatterns.length > 0 ? config.ctaPhrasePatterns : DEFAULT_CTA_PHRASE_PATTERNS
}

export function usesCustomKeyPages(config: TenantTrackingConfig): boolean {
  return config.keyPagePatterns.length > 0
}

export function usesCustomCtaRules(config: TenantTrackingConfig): boolean {
  return config.ctaUrlPatterns.length > 0 || config.ctaPhrasePatterns.length > 0
}

/** True when Postgres/Prisma error is a missing column (pre-migration deploy). */
export function isMissingDbColumn(error: unknown, column: string): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  return msg.toLowerCase().includes(column.toLowerCase())
}

function normalizeUrlForMatch(url: string): string {
  try {
    const u = new URL(url)
    return `${u.hostname}${u.pathname}${u.search}`.toLowerCase()
  } catch {
    return url.toLowerCase()
  }
}

export function urlMatchesPattern(url: string | null | undefined, pattern: string): boolean {
  if (!url || !pattern.trim()) return false
  const p = normalizePattern(pattern)
  const raw = url.toLowerCase()
  const normalized = normalizeUrlForMatch(url)
  if (p.startsWith('http://') || p.startsWith('https://')) {
    return raw.includes(p) || normalized.includes(normalizeUrlForMatch(p))
  }
  const pathBit = p.startsWith('/') ? p : `/${p}`
  return (
    raw.includes(p) ||
    normalized.includes(p) ||
    normalized.includes(pathBit) ||
    normalized.endsWith(pathBit)
  )
}

export function textMatchesPattern(text: string | null | undefined, pattern: string): boolean {
  if (!text || !pattern.trim()) return false
  return normalizePattern(text).includes(normalizePattern(pattern))
}

export function matchesKeyPage(
  url: string | null | undefined,
  config: TenantTrackingConfig
): boolean {
  if (!url) return false
  return effectiveKeyPagePatterns(config).some((p) => urlMatchesPattern(url, p))
}

export interface CtaEventShape {
  eventType?: string | null
  url?: string | null
  elementIdentifier?: string | null
  elementText?: string | null
  title?: string | null
}

export function matchesCtaEvent(event: CtaEventShape, config: TenantTrackingConfig): boolean {
  if (isFormSubmit(event.eventType)) return true

  const urlPatterns = effectiveCtaUrlPatterns(config)
  for (const p of urlPatterns) {
    if (urlMatchesPattern(event.url, p)) return true
  }

  const phrasePatterns = effectiveCtaPhrasePatterns(config)
  const textFields = [event.elementText, event.elementIdentifier, event.title]
  for (const p of phrasePatterns) {
    if (textFields.some((t) => textMatchesPattern(t, p))) return true
  }

  return false
}
