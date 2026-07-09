'use client'

import { useState, useEffect, useCallback } from 'react'
import type { ObservationConfidence } from '@/lib/ai-summary'
import { getRoiContextForApi } from '@/lib/roi-storage'

interface AISummaryProps {
  tenantId: string
  window: string
  /** When an upload is still processing, summary metrics may be incomplete */
  uploadProcessing?: boolean
}

interface PriorityAction {
  action: string
  estimatedImpact: string
  urgency: string
}

interface KeyObservationItem {
  observation: string
  confidence: ObservationConfidence
}

interface Summary {
  id: string
  executiveSummary: string
  keyObservations: KeyObservationItem[]
  recommendedActions: string[]
  notableSegments: Array<{ segment: string; description: string }>
  priorityAction: PriorityAction | null
  revenueInsights: string[]
  createdAt: string
}

function confidenceBadgeClass(c: ObservationConfidence) {
  switch (c) {
    case 'High':
      return 'bg-emerald-100 text-emerald-800 border-emerald-200'
    case 'Low':
      return 'bg-rose-100 text-rose-800 border-rose-200'
    default:
      return 'bg-amber-100 text-amber-900 border-amber-200'
  }
}

function confidenceLabel(c: ObservationConfidence) {
  switch (c) {
    case 'High':
      return 'High'
    case 'Low':
      return 'Low'
    default:
      return 'Medium'
  }
}

function normalizeSummary(data: Record<string, unknown>): Summary {
  const rawObs = data.keyObservations
  let keyObservations: KeyObservationItem[] = []
  if (Array.isArray(rawObs)) {
    keyObservations = rawObs.map((item) => {
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

  let priorityAction: PriorityAction | null = null
  const pa = data.priorityAction
  if (pa && typeof pa === 'object' && pa !== null && 'action' in pa) {
    const p = pa as Record<string, unknown>
    if (typeof p.action === 'string' && p.action.trim()) {
      priorityAction = {
        action: p.action.trim(),
        estimatedImpact: String(p.estimatedImpact ?? ''),
        urgency: String(p.urgency ?? ''),
      }
    }
  }

  let revenueInsights: string[] = []
  const ri = data.revenueInsights
  if (Array.isArray(ri)) {
    revenueInsights = ri.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
  }

  const recommendedActions: string[] = Array.isArray(data.recommendedActions)
    ? data.recommendedActions
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
    : []

  const notableSegments: Summary['notableSegments'] = Array.isArray(data.notableSegments)
    ? data.notableSegments
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
        .filter((s): s is Summary['notableSegments'][number] => s !== null)
    : []

  return {
    id: String(data.id ?? ''),
    executiveSummary: String(data.executiveSummary ?? ''),
    keyObservations,
    recommendedActions,
    notableSegments,
    priorityAction,
    revenueInsights,
    createdAt: String(data.createdAt ?? ''),
  }
}

export default function AISummary({ tenantId, window, uploadProcessing = false }: AISummaryProps) {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loadingExisting, setLoadingExisting] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revenueOpen, setRevenueOpen] = useState(true)

  const busy = loadingExisting || generating

  async function fetchWithTimeout(
    input: RequestInfo | URL,
    init: RequestInit,
    timeoutMs: number
  ): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await fetch(input, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  const loadSummary = useCallback(async () => {
    setLoadingExisting(true)
    setError(null)
    try {
      const res = await fetch(`/api/ai-summary?tenantId=${tenantId}&window=${window}`)
      if (res.ok) {
        const data = await res.json()
        setSummary(normalizeSummary(data))
      } else if (res.status === 404) {
        setError(null)
        setSummary(null)
      } else {
        const err = await res.json()
        setError(err.error || 'Failed to load summary')
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== 'TypeError') {
        setError(err.message || 'Failed to load summary')
      }
    } finally {
      setLoadingExisting(false)
    }
  }, [tenantId, window])

  const generateSummary = async () => {
    setGenerating(true)
    setError(null)
    try {
      const roiContext = getRoiContextForApi(tenantId)
      const res = await fetchWithTimeout(
        '/api/ai-summary',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tenantId,
            window,
            forceRegenerate: true,
            ...(roiContext ? { roiContext } : {}),
          }),
        },
        110_000
      )
      if (res.ok) {
        const data = await res.json()
        setSummary(normalizeSummary(data))
      } else {
        const err = await res.json().catch(() => ({}))
        setError((err as { error?: string }).error || 'Failed to generate summary')
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        setError(
          'Summary generation timed out. The server may still be working — click Refresh in a minute, or try a shorter date window.'
        )
      } else {
        setError(err instanceof Error ? err.message : 'Failed to generate summary')
      }
    } finally {
      setGenerating(false)
    }
  }

  useEffect(() => {
    void loadSummary()
  }, [loadSummary])

  return (
    <div className="overflow-hidden rounded-xl bg-white shadow-sm border border-gray-200">
      <div className="border-b border-gray-100 bg-white px-6 py-5">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">AI Summary</h2>
          <div className="flex gap-2">
            <button
              onClick={loadSummary}
              disabled={busy}
              className="rounded-md px-3 py-1 text-sm text-white disabled:opacity-50 btn-primary-orange"
            >
              Refresh
            </button>
            <button
              onClick={generateSummary}
              disabled={busy}
              className="rounded-md px-3 py-1 text-sm text-white disabled:opacity-50 btn-primary-blue"
            >
              {generating ? 'Generating…' : 'Generate Summary'}
            </button>
          </div>
        </div>
        {uploadProcessing && (
          <p className="mt-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
            Upload still processing — you can generate a summary from data loaded so far; refresh after
            the upload completes for the full picture.
          </p>
        )}
      </div>

      <div className="p-6">
        {loadingExisting && !summary && (
          <div className="text-center text-gray-500">Loading saved summary…</div>
        )}

        {generating && (
          <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
            Generating summary — this usually takes 15–45 seconds for larger datasets.
          </div>
        )}

        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 p-4 text-sm text-red-800">
            {error}
          </div>
        )}

        {summary && (
          <div className="space-y-6">
            {summary.priorityAction && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 shadow-sm">
                <p className="font-semibold text-amber-900">Priority action</p>
                <p className="mt-1 leading-relaxed">{summary.priorityAction.action}</p>
                <div className="mt-2 flex flex-wrap gap-3 text-xs text-amber-900/90">
                  {summary.priorityAction.estimatedImpact && (
                    <span>
                      <span className="font-medium">Estimated impact:</span>{' '}
                      {summary.priorityAction.estimatedImpact}
                    </span>
                  )}
                  {summary.priorityAction.urgency && (
                    <span>
                      <span className="font-medium">Urgency:</span> {summary.priorityAction.urgency}
                    </span>
                  )}
                </div>
              </div>
            )}

            <div>
              <h3 className="mb-2 text-sm font-semibold text-gray-700">Executive Summary</h3>
              <p className="text-sm text-gray-600 leading-relaxed">{summary.executiveSummary}</p>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-semibold text-gray-700">Key Observations</h3>
              <ul className="space-y-2 pl-0 list-none">
                {summary.keyObservations.map((obs, idx) => (
                  <li key={idx} className="flex gap-2 text-sm text-gray-600">
                    <span
                      className={`shrink-0 self-start rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${confidenceBadgeClass(obs.confidence)}`}
                    >
                      {confidenceLabel(obs.confidence)}
                    </span>
                    <span className="leading-relaxed">{obs.observation}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-semibold text-gray-700">Recommended Actions</h3>
              <ul className="list-disc space-y-1 pl-5 text-sm text-gray-600">
                {summary.recommendedActions.map((action, idx) => (
                  <li key={idx}>{action}</li>
                ))}
              </ul>
            </div>

            {summary.revenueInsights.length > 0 && (
              <div className="rounded-lg border border-gray-200 bg-gray-50">
                <button
                  type="button"
                  onClick={() => setRevenueOpen((o) => !o)}
                  className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold text-gray-800"
                >
                  Revenue insights
                  <span className="text-gray-500">{revenueOpen ? '▼' : '▶'}</span>
                </button>
                {revenueOpen && (
                  <ul className="list-disc space-y-1 border-t border-gray-200 px-4 py-3 pl-8 text-sm text-gray-600">
                    {summary.revenueInsights.map((line, idx) => (
                      <li key={idx}>{line}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {summary.notableSegments && summary.notableSegments.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-semibold text-gray-700">Notable Segments</h3>
                <div className="space-y-2">
                  {summary.notableSegments.map((seg, idx) => (
                    <div key={idx} className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                      <p className="text-sm font-medium text-gray-900">{seg.segment}</p>
                      <p className="text-xs text-gray-600">{seg.description}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="text-xs text-gray-500">
              Generated: {new Date(summary.createdAt).toLocaleString()}
            </div>
          </div>
        )}

        {!summary && !busy && !error && (
          <div className="text-center text-gray-500">
            <p>No summary available. Click &quot;Generate Summary&quot; to create one.</p>
          </div>
        )}
      </div>
    </div>
  )
}
