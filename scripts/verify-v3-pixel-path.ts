/**
 * Verifies Smart Pixel CSV rows parse with parseRow (no DB).
 * Pass a file path or rely on default V3 sample.
 * Run: npm run verify:v3
 */
import fs from 'fs'
import path from 'path'
import Papa from 'papaparse'
import { parseRow, type CSVRow } from '../lib/csv-processor'
import { detectPixelFormatFromCsvRow } from '../lib/pixel-format'

const root = path.join(__dirname, '..')
const defaultCsv = path.join(root, 'small pixel file.csv')
const csvPath = process.argv[2] ? path.resolve(process.cwd(), process.argv[2]) : defaultCsv

if (!fs.existsSync(csvPath)) {
  console.error('CSV not found:', csvPath)
  process.exit(1)
}

const text = fs.readFileSync(csvPath, 'utf8')

const parsed = Papa.parse<CSVRow>(text, {
  header: true,
  skipEmptyLines: true,
  transformHeader: (h) => h.trim(),
})

const sampleRow = parsed.data.find((r) => Object.keys(r).length > 0)
const format = sampleRow ? detectPixelFormatFromCsvRow(sampleRow) : 'unknown'

console.log('File:', csvPath)
console.log('Detected pixel format:', format)

let parsedOk = 0
let missingUrl = 0

for (const row of parsed.data) {
  const ev = parseRow(row)
  if (!ev) continue
  parsedOk++
  if (!ev.url) missingUrl++
}

const v3Sample = parsed.data.find((r) => r.EVENT_DATA && r.EVENT_TYPE)
if (v3Sample) {
  const ev = parseRow(v3Sample)
  console.log('Sample EVENT_TYPE:', v3Sample.EVENT_TYPE)
  console.log('parseRow url:', ev?.url?.slice(0, 72))
}

console.log('Rows successfully parsed:', parsedOk)
console.log('Rows missing URL after parse:', missingUrl)

if (parsedOk === 0) {
  console.error('FAIL: no parsable rows')
  process.exit(1)
}

console.log('OK: parseRow works for this file.')
