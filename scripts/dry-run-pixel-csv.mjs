#!/usr/bin/env node
/**
 * Dry-run: CSV headers + row counts (no database).
 * Usage: node scripts/dry-run-pixel-csv.mjs path/to/file.csv
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import Papa from 'papaparse'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function parseHeaderLine(firstLine) {
  const parsed = Papa.parse(firstLine, { header: false })
  const row = parsed.data[0]
  if (!row) return []
  return row.map((h) => String(h).trim())
}

const fileArg = process.argv[2] || path.join(__dirname, '..', 'small pixel file.csv')
const abs = path.resolve(process.cwd(), fileArg)

if (!fs.existsSync(abs)) {
  console.error('File not found:', abs)
  process.exit(1)
}

const text = fs.readFileSync(abs, 'utf8')
const firstLine = text.split(/\r?\n/).find((l) => l.length > 0) || ''
const headers = parseHeaderLine(firstLine)
const n = headers.map((s) => s.trim().toLowerCase())
const hasEventData = n.includes('event_data')
const hasEventsCol = n.includes('events')
const hasFullUrl = n.includes('full_url')

const parsed = Papa.parse(text, { header: true, skipEmptyLines: true })
const rows = parsed.data.filter((r) => Object.keys(r).length > 0)
const sample = rows[0] || {}
const sampleEvents = sample.EVENTS || sample.Events || sample.events
const eventsJsonRows = rows.filter((r) => {
  const ev = r.EVENTS || r.Events || r.events
  return ev && String(ev).trim().startsWith('[')
}).length

console.log('File:', abs)
console.log('Header count:', headers.length)
console.log('Detected format hint:', hasEventData ? 'v3 (EVENT_DATA)' : hasFullUrl ? 'v4 (FULL_URL)' : 'unknown')
console.log('Has EVENT_DATA column:', hasEventData)
console.log('Has EVENTS column (V4 behavioral JSON):', hasEventsCol)
console.log('Data rows (after header):', rows.length)
console.log('Rows with EVENTS JSON array:', eventsJsonRows)
console.log('Sample columns present:', {
  EVENT_DATA: sample.EVENT_DATA != null && String(sample.EVENT_DATA).length > 0,
  EVENTS: sampleEvents != null && String(sampleEvents).trim().startsWith('['),
  EVENT_TYPE: sample.EVENT_TYPE != null && String(sample.EVENT_TYPE).length > 0,
  FULL_URL: sample.FULL_URL != null && String(sample.FULL_URL).length > 0,
  HEM_SHA256: sample.HEM_SHA256 != null && String(sample.HEM_SHA256).length > 0,
})
