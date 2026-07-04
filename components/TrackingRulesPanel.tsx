'use client'

import { useState, useEffect } from 'react'
import {
  normalizeTrackingConfig,
  parsePatternList,
  patternsToTextarea,
  type TenantTrackingConfig,
} from '@/lib/tenant-tracking-config'

interface TrackingRulesPanelProps {
  tenantId: string
  trackingConfig: TenantTrackingConfig
  usesCustomKeyPages: boolean
  usesCustomCtaRules: boolean
  openRequest?: number
  onSaved: () => void
}

export default function TrackingRulesPanel({
  tenantId,
  trackingConfig,
  usesCustomKeyPages,
  usesCustomCtaRules,
  openRequest = 0,
  onSaved,
}: TrackingRulesPanelProps) {
  const [open, setOpen] = useState(!usesCustomKeyPages && !usesCustomCtaRules)
  const [saving, setSaving] = useState(false)
  const [keyPagesText, setKeyPagesText] = useState(() =>
    patternsToTextarea(trackingConfig.keyPagePatterns)
  )
  const [ctaUrlsText, setCtaUrlsText] = useState(() =>
    patternsToTextarea(trackingConfig.ctaUrlPatterns)
  )
  const [ctaPhrasesText, setCtaPhrasesText] = useState(() =>
    patternsToTextarea(trackingConfig.ctaPhrasePatterns)
  )

  useEffect(() => {
    setKeyPagesText(patternsToTextarea(trackingConfig.keyPagePatterns))
    setCtaUrlsText(patternsToTextarea(trackingConfig.ctaUrlPatterns))
    setCtaPhrasesText(patternsToTextarea(trackingConfig.ctaPhrasePatterns))
  }, [trackingConfig])

  useEffect(() => {
    if (openRequest > 0) setOpen(true)
  }, [openRequest])

  const handleSave = async () => {
    setSaving(true)
    try {
      const res = await fetch(`/api/tenants/${tenantId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trackingConfig: {
            keyPagePatterns: parsePatternList(keyPagesText),
            ctaUrlPatterns: parsePatternList(ctaUrlsText),
            ctaPhrasePatterns: parsePatternList(ctaPhrasesText),
          },
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        alert((err as { error?: string }).error || 'Failed to save tracking rules')
        return
      }
      setOpen(false)
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  const needsSetup = !usesCustomKeyPages && !usesCustomCtaRules

  return (
    <div className="mb-4 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-5 py-4 text-left hover:bg-gray-50"
      >
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Key pages &amp; CTA filters</h3>
          <p className="mt-0.5 text-xs text-gray-500">
            {needsSetup
              ? 'Using generic defaults — configure your site’s pages and CTAs for accurate filters.'
              : 'Custom rules active — click to edit.'}
          </p>
        </div>
        <span className="text-gray-400">{open ? '▼' : '▶'}</span>
      </button>

      {open && (
        <div className="space-y-4 border-t border-gray-100 px-5 py-4">
          <div>
            <label className="block text-xs font-semibold text-gray-800">Key pages</label>
            <p className="mt-0.5 text-xs text-gray-500">
              One per line: URL paths or fragments (e.g. /pricing, /contact, /request-demo)
            </p>
            <textarea
              rows={4}
              value={keyPagesText}
              onChange={(e) => setKeyPagesText(e.target.value)}
              placeholder={'/pricing\n/contact\n/request-demo\n/landing-page'}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-xs"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-800">CTA — URLs</label>
            <p className="mt-0.5 text-xs text-gray-500">Conversion page URLs or path fragments</p>
            <textarea
              rows={3}
              value={ctaUrlsText}
              onChange={(e) => setCtaUrlsText(e.target.value)}
              placeholder={'/thank-you\n/book-demo\n/get-started'}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-xs"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-800">CTA — link / button text</label>
            <p className="mt-0.5 text-xs text-gray-500">
              Exact phrases from pixel link labels (V4). Form submits always count.
            </p>
            <textarea
              rows={3}
              value={ctaPhrasesText}
              onChange={(e) => setCtaPhrasesText(e.target.value)}
              placeholder={'request demo now\nget your traffic intelligence review'}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-xs"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={() => void handleSave()}
              className="rounded-md px-3 py-1.5 text-xs text-white btn-primary-blue disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save & refresh filters'}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md px-3 py-1.5 text-xs text-gray-600 hover:text-gray-900"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
