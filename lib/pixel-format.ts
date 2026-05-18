/**
 * Smart Pixel CSV exports: V3 carries rich behavioral JSON in EVENT_DATA; V4 uses FULL_URL
 * and omits EVENT_DATA (identity / URL columns only for many rows).
 */
export type PixelFormat = 'v3' | 'v4' | 'unknown'

/** Normalize CSV header keys (trim, strip BOM, lowercase). */
export function normalizeCsvHeaderKey(key: string): string {
  return key.replace(/^\ufeff/, '').trim().toLowerCase()
}

/**
 * Detect pixel file version from column headers present on a parsed row object.
 */
export function detectPixelFormatFromCsvRow(row: Record<string, unknown>): PixelFormat {
  const keys = new Set(
    Object.keys(row)
      .map((k) => normalizeCsvHeaderKey(k))
      .filter(Boolean)
  )

  const hasEventData = keys.has('event_data')
  const hasFullUrl = keys.has('full_url')

  if (hasEventData) return 'v3'
  if (hasFullUrl && !hasEventData) return 'v4'
  return 'unknown'
}
