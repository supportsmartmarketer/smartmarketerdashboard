'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'

interface Tenant {
  id: string
  name: string
  domain: string | null
  createdAt: string
  showFinancialInsights?: boolean
}

export default function TenantsPage() {
  const [tenants, setTenants] = useState<Tenant[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [formData, setFormData] = useState({ name: '', domain: '', showFinancialInsights: true })

  useEffect(() => {
    fetchTenants()
  }, [])

  const fetchTenants = async () => {
    try {
      const res = await fetch('/api/tenants')
      if (!res.ok) {
        const error = await res.json()
        console.error('Error fetching tenants:', error)
        setTenants([])
        return
      }
      const data = await res.json()
      // Ensure data is an array
      setTenants(Array.isArray(data) ? data : [])
    } catch (error) {
      console.error('Error fetching tenants:', error)
      setTenants([])
    } finally {
      setLoading(false)
    }
  }

  const handleToggleFinancial = async (id: string, next: boolean) => {
    try {
      const res = await fetch(`/api/tenants/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ showFinancialInsights: next }),
      })
      if (res.ok) fetchTenants()
      else {
        const err = await res.json().catch(() => ({}))
        alert((err as { error?: string }).error || 'Failed to update')
      }
    } catch {
      alert('Failed to update')
    }
  }

  const handleClearData = async (id: string, name: string) => {
    if (
      !confirm(
        `Clear all data for "${name}"?\n\nThis removes uploads, events, visitor profiles, and AI summaries. The client stays (same link/settings) so you can upload fresh files.\n\nThis cannot be undone.`
      )
    )
      return
    try {
      const res = await fetch(`/api/tenants/${id}/data`, { method: 'DELETE' })
      if (res.ok) {
        fetchTenants()
      } else {
        const err = await res.json().catch(() => ({}))
        alert((err as { error?: string }).error || 'Failed to clear data')
      }
    } catch (error) {
      console.error('Error clearing tenant data:', error)
      alert('Failed to clear data')
    }
  }

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete client "${name}" and all their data (uploads, events, visitors)? This cannot be undone.`)) return
    try {
      const res = await fetch(`/api/tenants/${id}`, { method: 'DELETE' })
      if (res.ok) {
        fetchTenants()
      } else {
        const err = await res.json()
        alert(err.error || 'Failed to delete client')
      }
    } catch (error) {
      console.error('Error deleting client:', error)
      alert('Failed to delete client')
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const res = await fetch('/api/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.name,
          domain: formData.domain,
          showFinancialInsights: formData.showFinancialInsights,
        }),
      })
      if (res.ok) {
        setFormData({ name: '', domain: '', showFinancialInsights: true })
        setShowForm(false)
        fetchTenants()
      } else {
        const error = await res.json()
        alert(error.error || 'Failed to create client')
      }
    } catch (error) {
      console.error('Error creating client:', error)
      alert('Failed to create client')
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="text-center">Loading...</div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Clients</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className="rounded-md px-4 py-2 text-white btn-primary-blue"
        >
          {showForm ? 'Cancel' : 'Create Client'}
        </button>
      </div>

      {showForm && (
        <div className="mb-6 rounded-lg border bg-white p-6 shadow">
          <h2 className="mb-4 text-lg font-semibold">Create New Client</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="name" className="block text-sm font-medium text-gray-700">
                Name *
              </label>
              <input
                type="text"
                id="name"
                required
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:outline-none focus:border-[#1D6E95] focus:ring-1 focus:ring-[#1D6E95]"
              />
            </div>
            <div>
              <label htmlFor="domain" className="block text-sm font-medium text-gray-700">
                Domain (optional)
              </label>
              <input
                type="text"
                id="domain"
                value={formData.domain}
                onChange={(e) => setFormData({ ...formData, domain: e.target.value })}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:outline-none focus:border-[#1D6E95] focus:ring-1 focus:ring-[#1D6E95]"
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="showFinancialNew"
                checked={formData.showFinancialInsights}
                onChange={(e) =>
                  setFormData({ ...formData, showFinancialInsights: e.target.checked })
                }
                className="h-4 w-4 rounded border-gray-300 text-[#1D6E95] focus:ring-[#1D6E95]"
              />
              <label htmlFor="showFinancialNew" className="text-sm text-gray-700">
                Show revenue &amp; financial forecasts (dashboard &amp; upload)
              </label>
            </div>
            <button
              type="submit"
              className="rounded-md px-4 py-2 text-white btn-primary-blue"
            >
              Create
            </button>
          </form>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border bg-white shadow">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Name
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Domain
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Created
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Financial UI
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 bg-white">
            {tenants.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-6 py-4 text-center text-gray-500">
                  No clients yet. Create one to get started.
                </td>
              </tr>
            ) : (
              tenants.map((tenant) => (
                <tr key={tenant.id}>
                  <td className="whitespace-nowrap px-6 py-4 text-sm font-medium text-gray-900">
                    {tenant.name}
                  </td>
                  <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-500">
                    {tenant.domain || '-'}
                  </td>
                  <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-500">
                    {new Date(tenant.createdAt).toLocaleDateString()}
                  </td>
                  <td className="whitespace-nowrap px-6 py-4 text-sm">
                    <label className="inline-flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-gray-300 text-[#1D6E95] focus:ring-[#1D6E95]"
                        checked={tenant.showFinancialInsights !== false}
                        onChange={(e) => handleToggleFinancial(tenant.id, e.target.checked)}
                      />
                      <span className="text-xs text-gray-600">
                        {tenant.showFinancialInsights !== false ? 'On' : 'Off'}
                      </span>
                    </label>
                  </td>
                  <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-500">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <Link
                        href={`/dashboard/${tenant.id}`}
                        className="link-primary-blue"
                      >
                        View Dashboard
                      </Link>
                      <button
                        type="button"
                        onClick={() => handleClearData(tenant.id, tenant.name)}
                        className="text-amber-700 hover:text-amber-900 text-sm font-medium"
                      >
                        Clear data
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(tenant.id, tenant.name)}
                        className="text-red-600 hover:text-red-800 text-sm"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

