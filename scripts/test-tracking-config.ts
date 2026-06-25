import {
  matchesCtaEvent,
  matchesKeyPage,
  normalizeTrackingConfig,
  urlMatchesPattern,
} from '../lib/tenant-tracking-config'

const cfg = normalizeTrackingConfig({
  keyPagePatterns: ['/pricing', '/request-demo'],
  ctaUrlPatterns: ['/thank-you'],
  ctaPhrasePatterns: ['request demo now'],
})

const checks: Array<[string, boolean, boolean]> = [
  ['key page pricing', matchesKeyPage('https://example.com/pricing', cfg), true],
  ['key page home', matchesKeyPage('https://example.com/', cfg), false],
  ['cta url', matchesCtaEvent({ url: 'https://example.com/thank-you' }, cfg), true],
  ['cta phrase', matchesCtaEvent({ elementText: 'Request Demo Now' }, cfg), true],
  ['cta miss', matchesCtaEvent({ url: 'https://example.com/about' }, cfg), false],
  ['form submit', matchesCtaEvent({ eventType: 'form_submit' }, cfg), true],
  ['defaults when empty', matchesKeyPage('https://x.com/contact', normalizeTrackingConfig(null)), true],
  ['url fragment', urlMatchesPattern('https://site.com/landing/ad-1', '/landing/ad-1'), true],
]

let failed = 0
for (const [name, got, want] of checks) {
  if (got !== want) {
    console.error('FAIL', name, { got, want })
    failed++
  }
}

if (failed) {
  process.exit(1)
}
console.log('tracking-config:', checks.length, 'checks passed')
