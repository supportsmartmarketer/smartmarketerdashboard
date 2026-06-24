'use client'

import { useState } from 'react'

interface Visitor {
  id: string
  visitorKey: string
  visitsCount: number
  totalTimeOnPageMs: number
  maxScrollPercentage: number
  lastSeenAt: string
  engagementSegment: string
  engagementScore: number
  flags: any
  city: string | null
  country: string | null
  region: string | null
  identity: any
}

interface VisitorListProps {
  visitors: Visitor[]
  onVisitorClick: (visitor: Visitor) => void
}

export default function VisitorList({ visitors, onVisitorClick }: VisitorListProps) {
  const [filters, setFilters] = useState({
    repeat: false,
    timeOver60s: false,
    visitedKeyPage: false,
    exitIntent: false,
    ctaClicked: false,
    segment: '',
  })

  const getSegmentColor = (segment: string) => {
    switch (segment) {
      case 'Action':
        return { bg: '#FF8C02', border: '#e67d00', text: 'text-white' }
      case 'HighIntent':
        return { bg: '#FF8C02', border: '#e67d00', text: 'text-white' }
      case 'Researcher':
        return { bg: '#1D6E95', border: '#155a7a', text: 'text-white' }
      case 'Casual':
        return { bg: '#6b7280', border: '#4b5563', text: 'text-white' }
      default:
        return { bg: '#6b7280', border: '#4b5563', text: 'text-white' }
    }
  }

  const getVisitorDisplayName = (visitor: Visitor) => {
    if (visitor.identity) {
      const firstName = visitor.identity.firstName || ''
      const lastName = visitor.identity.lastName || ''
      const fullName = `${firstName} ${lastName}`.trim()
      if (fullName) return fullName
    }
    // Fallback to masked key
    if (visitor.visitorKey.length <= 6) return '***' + visitor.visitorKey
    return '***' + visitor.visitorKey.slice(-6)
  }

  const getVisitorAddress = (visitor: Visitor) => {
    if (!visitor.identity) return null
    const parts = []
    if (visitor.identity.address) parts.push(visitor.identity.address)
    if (visitor.identity.city) parts.push(visitor.identity.city)
    if (visitor.identity.state) parts.push(visitor.identity.state)
    if (visitor.identity.zip) parts.push(visitor.identity.zip)
    return parts.length > 0 ? parts.join(', ') : null
  }

  const filteredVisitors = visitors.filter((v) => {
    if (filters.repeat && !v.flags?.is_repeat_visitor) return false
    if (filters.timeOver60s && v.totalTimeOnPageMs < 60000) return false
    if (filters.visitedKeyPage && !v.flags?.visited_key_page) return false
    if (filters.exitIntent && !v.flags?.exit_intent_triggered) return false
    if (filters.ctaClicked && !v.flags?.cta_clicked) return false
    if (filters.segment && v.engagementSegment !== filters.segment) return false
    return true
  })

  return (
    <div className="overflow-hidden rounded-xl bg-white shadow-sm border border-gray-200">
      <div className="px-6 py-5 border-b border-gray-100">
        <h2 className="text-lg font-semibold text-gray-900">Visitor List</h2>
      </div>

      {/* Filters */}
      <div className="border-b border-gray-100 bg-gray-50 px-6 py-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <label className="flex items-center">
            <input
              type="checkbox"
              checked={filters.repeat}
              onChange={(e) => setFilters({ ...filters, repeat: e.target.checked })}
              className="mr-2"
            />
            <span className="text-sm">Repeat</span>
          </label>
          <label className="flex items-center">
            <input
              type="checkbox"
              checked={filters.timeOver60s}
              onChange={(e) => setFilters({ ...filters, timeOver60s: e.target.checked })}
              className="mr-2"
            />
            <span className="text-sm">Time &gt; 60s</span>
          </label>
          <label className="flex items-center">
            <input
              type="checkbox"
              checked={filters.visitedKeyPage}
              onChange={(e) => setFilters({ ...filters, visitedKeyPage: e.target.checked })}
              className="mr-2"
            />
            <span className="text-sm">Key Page</span>
          </label>
          <label className="flex items-center">
            <input
              type="checkbox"
              checked={filters.exitIntent}
              onChange={(e) => setFilters({ ...filters, exitIntent: e.target.checked })}
              className="mr-2"
            />
            <span className="text-sm">Exit Intent</span>
          </label>
          <label className="flex items-center">
            <input
              type="checkbox"
              checked={filters.ctaClicked}
              onChange={(e) => setFilters({ ...filters, ctaClicked: e.target.checked })}
              className="mr-2"
            />
            <span className="text-sm">CTA Clicked</span>
          </label>
          <select
            value={filters.segment}
            onChange={(e) => setFilters({ ...filters, segment: e.target.value })}
            className="rounded border border-gray-300 px-2 py-1 text-sm"
          >
            <option value="">All Segments</option>
            <option value="Casual">Casual</option>
            <option value="Researcher">Researcher</option>
            <option value="HighIntent">High Intent</option>
            <option value="Action">Action</option>
          </select>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Name
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Company
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Visits
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Time
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Scroll
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Segment
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Location
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Address
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Last Seen
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white">
            {filteredVisitors.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-6 py-4 text-center text-gray-500">
                  No visitors match the filters
                </td>
              </tr>
            ) : (
              filteredVisitors.map((visitor) => {
                const displayName = getVisitorDisplayName(visitor)
                const address = getVisitorAddress(visitor)
                const company = visitor.identity?.companyName || '-'
                const location = [visitor.city, visitor.region, visitor.country].filter(Boolean).join(', ') || '-'
                
                return (
                  <tr
                    key={visitor.id}
                    onClick={() => onVisitorClick(visitor)}
                    className="cursor-pointer hover:bg-gray-50 transition-colors"
                  >
                    <td className="whitespace-nowrap px-6 py-4 text-sm font-medium text-gray-900">
                      {displayName}
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-600">
                      {company}
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-600">
                      {visitor.visitsCount}
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-600">
                      {Math.round((Number(visitor.totalTimeOnPageMs) || 0) / 1000)}s
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-600">
                      {(Number(visitor.maxScrollPercentage) || 0).toFixed(0)}%
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-sm">
                      <span
                        className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${getSegmentColor(
                          visitor.engagementSegment
                        ).text}`}
                        style={{ 
                          backgroundColor: getSegmentColor(visitor.engagementSegment).bg,
                          borderColor: getSegmentColor(visitor.engagementSegment).border,
                          borderWidth: '1px',
                          borderStyle: 'solid'
                        }}
                      >
                        {visitor.engagementSegment}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-600">
                      {location}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-600 max-w-xs truncate" title={address || undefined}>
                      {address || '-'}
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-600">
                      {new Date(visitor.lastSeenAt).toLocaleDateString()}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

