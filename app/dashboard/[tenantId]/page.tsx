'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import KPICards from '@/components/KPICards'
import ROICalculator from '@/components/ROICalculator'
import EngagementBreakdown from '@/components/EngagementBreakdown'
import VisitorMap from '@/components/VisitorMap'
import VisitorList from '@/components/VisitorList'
import AISummary from '@/components/AISummary'
import RevenueEstimator from '@/components/RevenueEstimator'

interface DashboardData {
  windowStart: string
  windowEnd: string
  showFinancialInsights: boolean
  latestUploadId: string | null
  processingUploadId: string | null
  trackingRules?: {
    keyPagePatterns: string[]
    ctaUrlPatterns: string[]
    ctaPhrasePatterns: string[]
    usesCustomKeyPages?: boolean
    usesCustomCtaRules?: boolean
  }
  metrics: {
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
  profiles: Array<{
    id: string
    visitorKey: string
    firstSeenAt: string
    lastSeenAt: string
    visitsCount: number
    totalEvents: number
    pageViews: number
    uniquePagesCount: number
    totalTimeOnPageMs: number
    avgTimeOnPageMs: number
    maxScrollPercentage: number
    flags: any
    engagementScore: number
    engagementSegment: string
    lat: number | null
    lng: number | null
    city: string | null
    region: string | null
    country: string | null
    identity: any
  }>
}

export default function DashboardPage() {
  const params = useParams()
  const router = useRouter()
  const tenantId = params.tenantId as string
  const [window, setWindow] = useState('L30')
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [revenueExpanded, setRevenueExpanded] = useState(true)
  const [autoSummaryState, setAutoSummaryState] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [financialTogglePending, setFinancialTogglePending] = useState(false)

  const patchFinancialInsights = async (next: boolean) => {
    setFinancialTogglePending(true)
    try {
      const res = await fetch(`/api/tenants/${tenantId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ showFinancialInsights: next }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        alert((err as { error?: string }).error || 'Could not update setting')
        return
      }
      await fetchDashboard(false)
    } finally {
      setFinancialTogglePending(false)
    }
  }

  const fetchDashboard = useCallback(async (isInitialLoad = false) => {
    if (isInitialLoad) {
      setLoading(true)
    } else {
      setRefreshing(true)
    }
    try {
      const res = await fetch(`/api/dashboard?tenantId=${tenantId}&window=${window}`)
      if (res.ok) {
        const dashboardData = await res.json()
        setData(dashboardData)
      } else {
        const error = await res.json()
        alert(error.error || 'Failed to load dashboard')
      }
    } catch (error) {
      console.error('Error fetching dashboard:', error)
      alert('Failed to load dashboard')
    } finally {
      if (isInitialLoad) {
        setLoading(false)
      } else {
        setRefreshing(false)
      }
    }
  }, [tenantId, window])

  useEffect(() => {
    if (tenantId) {
      void fetchDashboard(true)
    }
  }, [tenantId, window, fetchDashboard])

  // Auto-refresh every 30 seconds to catch new uploads (less aggressive)
  useEffect(() => {
    if (!tenantId) return

    const interval = setInterval(() => {
      if (!loading && !refreshing) {
        void fetchDashboard(false)
      }
    }, 30000)

    return () => clearInterval(interval)
  }, [tenantId, window, loading, refreshing, fetchDashboard])

  useEffect(() => {
    if (!tenantId || !data?.latestUploadId) return
    const params = new URLSearchParams(globalThis.window.location.search)
    if (params.get('autoGenerateSummary') !== '1') return
    if (autoSummaryState === 'running' || autoSummaryState === 'done') return

    let cancelled = false
    const run = async () => {
      setAutoSummaryState('running')
      try {
        const res = await fetch('/api/ai-summary', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tenantId,
            window,
            forceRegenerate: true,
          }),
        })

        if (!res.ok) {
          throw new Error('Failed to auto-generate summary')
        }

        if (!cancelled) {
          setAutoSummaryState('done')
          const nextParams = new URLSearchParams(globalThis.window.location.search)
          nextParams.delete('autoGenerateSummary')
          const next = nextParams.toString()
          const nextUrl = next ? `/dashboard/${tenantId}?${next}` : `/dashboard/${tenantId}`
          globalThis.window.history.replaceState({}, '', nextUrl)
        }
      } catch (error) {
        console.error('Auto-generate summary failed:', error)
        if (!cancelled) setAutoSummaryState('error')
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [tenantId, window, data?.latestUploadId, autoSummaryState])

  const handleVisitorClick = (visitor: any) => {
    router.push(`/dashboard/${tenantId}/visitors?select=${encodeURIComponent(visitor.visitorKey)}`)
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="text-center">Loading dashboard...</div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="text-center text-red-600">Failed to load dashboard data</div>
      </div>
    )
  }

  const highIntent = data.metrics.highIntentVisitors
  const defaultMatchRate = 0.5
  const defaultCloseRate = 0.1
  const defaultDealValue = 1000
  const estMonthlyRevenue = Math.round(
    highIntent * defaultMatchRate * defaultCloseRate * defaultDealValue
  )

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 bg-white min-h-screen">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <div className="flex flex-col items-end gap-2 sm:flex-row sm:items-center sm:gap-4">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-gray-300 text-[#1D6E95] focus:ring-[#1D6E95]"
              checked={data.showFinancialInsights}
              disabled={financialTogglePending || loading || refreshing}
              onChange={(e) => void patchFinancialInsights(e.target.checked)}
            />
            <span>Show revenue &amp; financial forecasts</span>
          </label>
          <button
            onClick={() => fetchDashboard(false)}
            disabled={loading || refreshing}
            className="rounded-md bg-gray-600 px-3 py-2 text-sm text-white hover:bg-gray-700 disabled:bg-gray-400"
          >
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
          <select
            value={window}
            onChange={(e) => setWindow(e.target.value)}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="L7">Last 7 days</option>
            <option value="L30">Last 30 days</option>
            <option value="L60">Last 60 days</option>
            <option value="L90">Last 90 days</option>
          </select>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="mb-6">
        <KPICards
          metrics={data.metrics}
          estMonthlyRevenue={data.showFinancialInsights ? estMonthlyRevenue : undefined}
        />
      </div>

      {data.showFinancialInsights && (
        <ROICalculator
          key={tenantId}
          tenantId={tenantId}
          reportWindow={window}
          metrics={data.metrics}
        />
      )}

      {data.showFinancialInsights && data.latestUploadId && (
        <div className="mb-6 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          <button
            type="button"
            onClick={() => setRevenueExpanded((e) => !e)}
            className="flex w-full items-center justify-between border-b border-gray-100 bg-white px-5 py-4 text-left transition hover:bg-gray-50"
          >
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Revenue estimate</h2>
              <p className="text-xs text-gray-500">
                From your latest processed pixel upload — match rate, close rate, and deal size (same
                model as the upload page).
              </p>
            </div>
            <span
              className={`ml-2 text-gray-500 transition-transform ${revenueExpanded ? 'rotate-180' : ''}`}
              aria-hidden
            >
              ▼
            </span>
          </button>
          {revenueExpanded && (
            <RevenueEstimator
              key={data.latestUploadId}
              uploadId={data.latestUploadId}
              tenantId={tenantId}
              embedded
            />
          )}
        </div>
      )}

      {/* Engagement Breakdown */}
      <div className="mb-6">
        <EngagementBreakdown
          breakdown={data.metrics.engagementBreakdown}
          total={data.metrics.totalVisitors}
        />
      </div>

      {/* Map and AI Summary Side by Side */}
      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <VisitorMap
          visitors={data.profiles}
          tenantId={tenantId}
          processingUploadId={data.processingUploadId ?? null}
          onRefreshDashboard={() => fetchDashboard(false)}
        />
        <AISummary
          tenantId={tenantId}
          window={window}
          uploadProcessing={Boolean(data.processingUploadId)}
        />
      </div>

      {/* Visitor List */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Visitors</h2>
          <Link
            href={`/dashboard/${tenantId}/visitors`}
            className="text-sm link-primary-blue"
          >
            View All Visitors →
          </Link>
        </div>
        <VisitorList
          visitors={data.profiles}
          onVisitorClick={handleVisitorClick}
          trackingRules={data.trackingRules}
        />
      </div>
    </div>
  )
}

