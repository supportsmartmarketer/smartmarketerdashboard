'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import {
  normalizeTrackingConfig,
  parsePatternList,
  patternsToTextarea,
  type TenantTrackingConfig,
} from '@/lib/tenant-tracking-config'

interface TenantRow {
  id: string
  name: string
  domain: string | null
  trackingConfig?: unknown
}

export default function TenantTrackingPage() {
  const params = useParams()
  const tenantId = params.tenantId as string
  const [tenant, setTenant] = useState<TenantRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [rebuilding, setRebuilding] = useState(false)
  const [keyPagesText, setKeyPagesText] = useState('')
  const [ctaUrlsText, setCtaUrlsText] = useState('')
  const [ctaPhrasesText, setCtaPhrasesText] = useState('')

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/tenants')
        if (!res.ok) return
        const tenants = (await res.json()) as TenantRow[]
        const found = tenants.find((t) => t.id === tenantId)
        if (found) {
          setTenant(found)
          const cfg = normalizeTrackingConfig(found.trackingConfig)
          setKeyPagesText(patternsToTextarea(cfg.keyPagePatterns))
          setCtaUrlsText(patternsToTextarea(cfg.ctaUrlPatterns))
          setCtaPhrasesText(patternsToTextarea(cfg.ctaPhrasePatterns))
        }
      } finally {
        setLoading(false)
      }
    })()
  }, [tenantId])

  const buildConfig = (): TenantTrackingConfig => ({
    keyPagePatterns: parsePatternList(keyPagesText),
    ctaUrlPatterns: parsePatternList(ctaUrlsText),
    ctaPhrasePatterns: parsePatternList(ctaPhrasesText),
  })

  const handleSave = async () => {
    setSaving(true)
    try {
      const res = await fetch(`/api/tenants/${tenantId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackingConfig: buildConfig() }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        alert((err as { error?: string }).error || 'Failed to save')
        return
      }
      const updated = (await res.json()) as TenantRow
      setTenant(updated)
      alert('Tracking rules saved.')
    } finally {
      setSaving(false)
    }
  }

  const handleSaveAndRebuild = async () => {
    setSaving(true)
    try {
      const patchRes = await fetch(`/api/tenants/${tenantId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackingConfig: buildConfig() }),
      })
      if (!patchRes.ok) {
        const err = await patchRes.json().catch(() => ({}))
        alert((err as { error?: string }).error || 'Failed to save')
        return
      }
      setRebuilding(true)
      const rebuildRes = await fetch(`/api/tenants/${tenantId}/rebuild-profiles`, {
        method: 'POST',
      })
      if (!rebuildRes.ok) {
        const err = await rebuildRes.json().catch(() => ({}))
        alert((err as { error?: string }).error || 'Saved but rebuild failed')
        return
      }
      const result = (await rebuildRes.json()) as { rebuilt: number }
      alert(`Saved and rebuilt ${result.rebuilt} visitor profiles.`)
    } finally {
      setSaving(false)
      setRebuilding(false)
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <p className="text-gray-500">Loading…</p>
      </div>
    )
  }

  if (!tenant) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <p className="text-red-600">Client not found.</p>
        <Link href="/admin/tenants" className="link-primary-blue mt-4 inline-block text-sm">
          ← Back to clients
        </Link>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6">
        <Link href="/admin/tenants" className="link-primary-blue text-sm">
          ← Back to clients
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-gray-900">Tracking rules — {tenant.name}</h1>
        <p className="mt-1 text-sm text-gray-600">
          Define which pages count as <strong>key pages</strong> and what counts as a{' '}
          <strong>CTA click</strong> for filters and intent scoring. One pattern per line.
        </p>
      </div>

      <div className="space-y-6 rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <div>
          <label htmlFor="keyPages" className="block text-sm font-semibold text-gray-900">
            Key pages
          </label>
          <p className="mt-1 text-xs text-gray-500">
            URL paths or fragments, e.g. <code className="text-gray-700">/pricing</code>,{' '}
            <code className="text-gray-700">contact</code>,{' '}
            <code className="text-gray-700">/request-demo</code>, landing page slugs from ads.
            Leave empty to use generic defaults (pricing, contact, demo, etc.).
          </p>
          <textarea
            id="keyPages"
            rows={6}
            value={keyPagesText}
            onChange={(e) => setKeyPagesText(e.target.value)}
            placeholder={'/pricing\n/contact\n/request-demo\n/landing-page'}
            className="mt-2 block w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm shadow-sm focus:border-[#1D6E95] focus:outline-none focus:ring-1 focus:ring-[#1D6E95]"
          />
        </div>

        <div>
          <label htmlFor="ctaUrls" className="block text-sm font-semibold text-gray-900">
            CTA — URLs
          </label>
          <p className="mt-1 text-xs text-gray-500">
            Full URLs or path fragments for pages/buttons that count as a conversion click.
          </p>
          <textarea
            id="ctaUrls"
            rows={5}
            value={ctaUrlsText}
            onChange={(e) => setCtaUrlsText(e.target.value)}
            placeholder={'/thank-you\n/get-started\n/book-demo'}
            className="mt-2 block w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm shadow-sm focus:border-[#1D6E95] focus:outline-none focus:ring-1 focus:ring-[#1D6E95]"
          />
        </div>

        <div>
          <label htmlFor="ctaPhrases" className="block text-sm font-semibold text-gray-900">
            CTA — link / button text
          </label>
          <p className="mt-1 text-xs text-gray-500">
            Phrases from pixel link or button labels, e.g.{' '}
            <em>request demo now</em>, <em>get your traffic intelligence review</em>. Form submits
            always count as CTA when captured in the export.
          </p>
          <textarea
            id="ctaPhrases"
            rows={5}
            value={ctaPhrasesText}
            onChange={(e) => setCtaPhrasesText(e.target.value)}
            placeholder={'request demo now\nget your traffic intelligence review\nbook a call'}
            className="mt-2 block w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm shadow-sm focus:border-[#1D6E95] focus:outline-none focus:ring-1 focus:ring-[#1D6E95]"
          />
        </div>

        <div className="flex flex-wrap gap-3 border-t border-gray-100 pt-4">
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || rebuilding}
            className="rounded-md px-4 py-2 text-sm text-white btn-primary-blue disabled:opacity-50"
          >
            {saving && !rebuilding ? 'Saving…' : 'Save rules'}
          </button>
          <button
            type="button"
            onClick={() => void handleSaveAndRebuild()}
            disabled={saving || rebuilding}
            className="rounded-md border border-[#1D6E95] bg-white px-4 py-2 text-sm font-medium text-[#1D6E95] hover:bg-blue-50 disabled:opacity-50"
          >
            {rebuilding ? 'Rebuilding profiles…' : 'Save & rebuild existing data'}
          </button>
          <Link
            href={`/dashboard/${tenantId}`}
            className="rounded-md px-4 py-2 text-sm text-gray-700 hover:text-gray-900"
          >
            View dashboard →
          </Link>
        </div>
      </div>
    </div>
  )
}
