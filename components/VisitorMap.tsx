'use client'

import { useEffect, useRef, useState, useMemo } from 'react'
import { resolveProfileMapLocation } from '@/lib/geo-fallback'

interface Visitor {
  id: string
  visitorKey: string
  lat: number | null
  lng: number | null
  city: string | null
  region?: string | null
  country?: string | null
  identity?: unknown
  engagementScore: number
  visitsCount: number
  totalTimeOnPageMs: number
  lastSeenAt: string
  mapApproximate?: boolean
}

function resolveVisitorForMap(visitor: Visitor): Visitor & { mapApproximate: boolean } {
  const resolved = resolveProfileMapLocation({
    visitorKey: visitor.visitorKey,
    lat: visitor.lat,
    lng: visitor.lng,
    city: visitor.city,
    region: visitor.region ?? null,
    country: visitor.country ?? null,
    identity: visitor.identity ?? null,
  })
  if (!resolved) {
    return { ...visitor, mapApproximate: visitor.mapApproximate ?? false }
  }
  return {
    ...visitor,
    lat: resolved.lat,
    lng: resolved.lng,
    city: resolved.city ?? visitor.city,
    region: resolved.region ?? visitor.region ?? null,
    mapApproximate: resolved.approximate,
  }
}

interface VisitorMapProps {
  visitors: Visitor[]
  /** When set, upload is still pending/processing — show notice and poll until done */
  tenantId?: string
  processingUploadId?: string | null
  onRefreshDashboard?: () => void
}

export default function VisitorMap({
  visitors,
  tenantId,
  processingUploadId,
  onRefreshDashboard,
}: VisitorMapProps) {
  const mapRef = useRef<any>(null)
  const markersRef = useRef<any[]>([])
  const containerRef = useRef<HTMLDivElement>(null)
  const initializedRef = useRef(false)
  const [mapReady, setMapReady] = useState(false)
  const refreshRef = useRef(onRefreshDashboard)
  refreshRef.current = onRefreshDashboard

  const mapVisitors = useMemo(
    () => visitors.map(resolveVisitorForMap),
    [visitors]
  )

  /** Hide “still processing” as soon as this upload finishes (don’t wait for parent refetch) */
  const [processingDismissed, setProcessingDismissed] = useState(false)

  useEffect(() => {
    setProcessingDismissed(false)
  }, [processingUploadId])

  // Initialize map only once
  useEffect(() => {
    if (!containerRef.current || initializedRef.current || typeof window === 'undefined') return

    import('leaflet').then((L) => {
      const map = L.default.map(containerRef.current!).setView([39.5, -98.35], 4)

      L.default.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
      }).addTo(map)

      mapRef.current = map
      initializedRef.current = true
      setMapReady(true)
    })

    return () => {
      if (mapRef.current) {
        mapRef.current.remove()
        mapRef.current = null
        initializedRef.current = false
        markersRef.current = []
      }
    }
  }, [])

  useEffect(() => {
    if (!processingUploadId || !tenantId) return

    const pollUpload = async () => {
      try {
        const qs = new URLSearchParams({ tenantId })
        const res = await fetch(`/api/upload/${processingUploadId}?${qs.toString()}`)
        if (!res.ok) return
        const upload = await res.json()
        if (upload.status === 'completed' || upload.status === 'error') {
          setProcessingDismissed(true)
          refreshRef.current?.()
        }
      } catch {
        // ignore — next tick will retry
      }
    }

    void pollUpload()
    const interval = setInterval(() => void pollUpload(), 8000)
    return () => clearInterval(interval)
  }, [processingUploadId, tenantId])

  // Update markers when visitors change or map becomes ready (fixes empty map on production)
  useEffect(() => {
    if (!mapRef.current || !initializedRef.current || !mapReady) return

    let cancelled = false

    import('leaflet').then((L) => {
      if (cancelled || !mapRef.current) return

      try {
        markersRef.current.forEach((marker) => {
          if (mapRef.current) mapRef.current.removeLayer(marker)
        })
        markersRef.current = []

        const visitorsWithCoords = mapVisitors.filter(
          (v) =>
            typeof v.lat === 'number' &&
            typeof v.lng === 'number' &&
            Number.isFinite(v.lat) &&
            Number.isFinite(v.lng)
        )

        visitorsWithCoords.forEach((visitor) => {
          if (!mapRef.current) return

          const color =
            visitor.engagementScore >= 9 ? '#FF8C02' :
            visitor.engagementScore >= 6 ? '#FF8C02' :
            visitor.engagementScore >= 3 ? '#1D6E95' :
            '#6b7280'

          const marker = L.default.circleMarker([visitor.lat!, visitor.lng!], {
            radius: 6,
            fillColor: color,
            color: '#fff',
            weight: 1,
            opacity: 1,
            fillOpacity: 0.7,
          }).addTo(mapRef.current)

          marker.bindPopup(`
          <div style="padding: 8px;">
            <p style="font-weight: 600; margin-bottom: 4px;">Visitor: ${visitor.visitorKey.slice(-6)}</p>
            <p style="margin: 2px 0;">Score: ${visitor.engagementScore}</p>
            <p style="margin: 2px 0;">Visits: ${visitor.visitsCount}</p>
            <p style="margin: 2px 0;">Time: ${Math.round((Number(visitor.totalTimeOnPageMs) || 0) / 1000)}s</p>
            ${visitor.city || visitor.region ? `<p style="margin: 2px 0;">Location: ${[visitor.city, visitor.region].filter(Boolean).join(', ')}</p>` : ''}
          </div>
        `)

          markersRef.current.push(marker)
        })

        if (visitorsWithCoords.length > 0 && mapRef.current) {
          const bounds = L.default.latLngBounds(
            visitorsWithCoords.map((v) => [v.lat!, v.lng!])
          )
          mapRef.current.fitBounds(bounds, { padding: [20, 20] })
        }
      } catch (err) {
        console.warn('Visitor map update skipped:', err)
      }
    })

    return () => {
      cancelled = true
    }
  }, [mapVisitors, mapReady])

  const coordCount = mapVisitors.filter(
    (v) =>
      typeof v.lat === 'number' &&
      typeof v.lng === 'number' &&
      Number.isFinite(v.lat) &&
      Number.isFinite(v.lng)
  ).length
  const approximateCount = mapVisitors.filter(
    (v) =>
      v.mapApproximate &&
      typeof v.lat === 'number' &&
      typeof v.lng === 'number' &&
      Number.isFinite(v.lat) &&
      Number.isFinite(v.lng)
  ).length
  const isProcessingUpload = Boolean(
    processingUploadId && tenantId && !processingDismissed
  )

  return (
    <div className="overflow-hidden rounded-xl bg-white shadow-sm border border-gray-200">
      {isProcessingUpload && (
        <div className="border-b border-blue-100 bg-blue-50 px-4 py-3 sm:px-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex gap-3">
              <div
                className="mt-0.5 h-8 w-8 flex-shrink-0 animate-spin rounded-full border-2 border-blue-200 border-t-blue-600"
                aria-hidden
              />
              <div>
                <p className="text-sm font-medium text-blue-950">Upload still processing</p>
                <p className="mt-0.5 text-xs leading-relaxed text-blue-900/85">
                  Visitor profiles and locations load as the job finishes. Use{' '}
                  <strong>Refresh</strong> above for the latest map, or wait — we reload when the job
                  completes.
                </p>
              </div>
            </div>
            {onRefreshDashboard && (
              <button
                type="button"
                onClick={() => onRefreshDashboard()}
                className="flex-shrink-0 rounded-md border border-blue-200 bg-white px-3 py-2 text-xs font-medium text-blue-900 shadow-sm hover:bg-blue-50"
              >
                Refresh map data
              </button>
            )}
          </div>
        </div>
      )}

      <div className="border-b border-gray-100 px-6 py-5">
        <h2 className="text-lg font-semibold text-gray-900">Visitor Map</h2>
        <p className="mt-1 text-sm text-gray-500">
          {coordCount > 0
            ? approximateCount > 0
              ? `${coordCount} visitors on map (${approximateCount} approximate state-level from city/state in CSV)`
              : `${coordCount} visitors with location data`
            : isProcessingUpload
              ? 'Locations will appear here as visitor profiles are built and geocoded.'
              : 'No location data — CSV needs city/state, address, or IP for map'}
        </p>
      </div>
      <div ref={containerRef} className="relative h-96 w-full">
        {coordCount === 0 && (
          <div className="absolute inset-0 z-[1000] flex items-center justify-center bg-gray-50/90">
            <p className="max-w-xs px-4 text-center text-sm text-gray-600">
              {isProcessingUpload
                ? 'Map points appear after profiles finish processing. Try Refresh map data or check back shortly.'
                : 'Add city/state or address columns in your CSV to show visitors on the map'}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
