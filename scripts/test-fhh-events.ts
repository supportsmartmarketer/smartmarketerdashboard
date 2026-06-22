import fs from 'fs'
import Papa from 'papaparse'
import { parseRowsFromCsvRow } from '../lib/csv-processor'

const p = process.argv[2]
if (!p) {
  console.error('Usage: npx tsx scripts/test-fhh-events.ts <csv-path>')
  process.exit(1)
}

const rows = Papa.parse<Record<string, string>>(fs.readFileSync(p, 'utf8'), {
  header: true,
  skipEmptyLines: true,
}).data

let total = 0
const types = new Map<string, number>()
let sample: ReturnType<typeof parseRowsFromCsvRow> | null = null

for (const row of rows) {
  const evs = parseRowsFromCsvRow(row)
  total += evs.length
  if (!sample && evs.length > 3) sample = evs
  for (const e of evs) {
    const k = e.eventType || '?'
    types.set(k, (types.get(k) || 0) + 1)
  }
}

console.log('CSV rows', rows.length, '-> expanded events', total)
console.log('types', [...types.entries()].sort((a, b) => b[1] - a[1]))
if (sample) {
  console.log(
    'sample journey',
    sample.slice(0, 6).map((e) => ({
      t: e.eventType,
      url: e.url?.replace(/^https?:\/\/[^/]+/, ''),
      scroll: e.scrollPct,
      form: e.elementIdentifier,
    }))
  )
}
