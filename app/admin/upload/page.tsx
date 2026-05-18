'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import RevenueEstimator from '@/components/RevenueEstimator'

interface Tenant {
  id: string
  name: string
  domain: string | null
}

interface UploadStatus {
  id: string
  status: string
  rowCount: number | null
  processedRows: number | null
  fileSizeBytes: number | null
  error: string | null
  processedAt: string | null
  tenantId: string
  visitorProfileTotal?: number | null
  visitorProfileProcessed?: number | null
}

export default function UploadPage() {
  const router = useRouter()
  const [tenants, setTenants] = useState<Tenant[]>([])
  const [selectedTenantId, setSelectedTenantId] = useState<string>('')
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [uploadStatus, setUploadStatus] = useState<UploadStatus | null>(null)
  const [progress, setProgress] = useState<string>('')
  const [progressPct, setProgressPct] = useState<number | null>(null)
  const [completedUploadId, setCompletedUploadId] = useState<string | null>(null)
  const [showProcessChoice, setShowProcessChoice] = useState(false)
  const [pendingUploadId, setPendingUploadId] = useState<string | null>(null)
  /** Ensures profile-phase choice modal only once per upload, after ingest finishes and profile build starts */
  const profileChoiceOfferedForUploadRef = useRef<string | null>(null)

  useEffect(() => {
    if (!selectedTenantId || !completedUploadId) return

    const timer = setTimeout(() => {
      router.push(`/dashboard/${selectedTenantId}?autoGenerateSummary=1`)
    }, 1200)

    return () => clearTimeout(timer)
  }, [selectedTenantId, completedUploadId, router])

  useEffect(() => {
    fetchTenants()
  }, [])

  const fetchTenants = async () => {
    try {
      const res = await fetch('/api/tenants')
      const data = await res.json()
      setTenants(data)
      if (data.length > 0 && !selectedTenantId) {
        setSelectedTenantId(data[0].id)
      }
    } catch (error) {
      console.error('Error fetching tenants:', error)
    }
  }

  const checkUploadStatus = async (uploadId: string): Promise<UploadStatus | null> => {
    try {
      const res = await fetch(`/api/upload/${uploadId}`)
      if (res.ok) {
        return await res.json()
      }
      return null
    } catch (error) {
      console.error('Error checking upload status:', error)
      return null
    }
  }

  const pollUploadStatus = async (uploadId: string, tenantId: string) => {
    setProcessing(true)
    setProgress('Processing…')
    setCompletedUploadId(null)

    // ~4 hours at 1s interval (large CSVs + visitor/geo work on the server)
    const maxAttempts = 14400
    let attempts = 0

    const poll = async () => {
      attempts++
      const status = await checkUploadStatus(uploadId)

      if (!status) {
        setProgress('Error checking upload status')
        setProcessing(false)
        return
      }

      setUploadStatus(status)

      if (status.status === 'completed') {
        setProgressPct(100)
        setProgress(`Processing complete! Processed ${status.rowCount || 0} rows.`)
        setProcessing(false)
        setCompletedUploadId(status.id)
        return
      }

      if (status.status === 'error') {
        setProgressPct(null)
        setProgress(`Error: ${status.error || 'Unknown error'}`)
        setProcessing(false)
        return
      }

      if (status.status === 'processing') {
        const vTotal = status.visitorProfileTotal
        const vProc = status.visitorProfileProcessed ?? 0
        const inProfilePhase = vTotal != null && vTotal > 0

        // Offer wait vs dashboard only when ingest is done and visitor-profile build begins (not at upload POST)
        if (inProfilePhase && profileChoiceOfferedForUploadRef.current !== uploadId) {
          profileChoiceOfferedForUploadRef.current = uploadId
          setPendingUploadId(uploadId)
          setShowProcessChoice(true)
          return
        }

        if (inProfilePhase) {
          const profilePct = Math.min(100, Math.round((vProc / vTotal) * 100))
          setProgressPct(profilePct)
          setProgress(
            `Building visitor profiles (${vProc.toLocaleString()} of ${vTotal.toLocaleString()})...`
          )
        } else {
          const n = status.processedRows ?? 0
          const fileSize = status.fileSizeBytes ?? 0
          const estimatedRows = fileSize > 0 ? Math.max(1, Math.round(fileSize / 400)) : 0
          const pct = estimatedRows > 0 && n > 0 ? Math.min(99, Math.round((n / estimatedRows) * 100)) : null
          setProgressPct(pct)
          if (pct != null) {
            setProgress(`Uploading rows... ${pct}% (${n.toLocaleString()} rows)`)
          } else {
            setProgress(
              n > 0
                ? `Uploading rows... ${n.toLocaleString()} rows ingested so far`
                : 'Uploading rows...'
            )
          }
        }
      }

      if (attempts < maxAttempts) {
        setTimeout(poll, 1000)
      } else {
        setProgress('Processing is taking longer than expected. You can check the dashboard later.')
        setProcessing(false)
      }
    }

    poll()
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.files?.[0] ?? null
    setFile(next)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!file || !selectedTenantId) {
      return
    }

    setUploading(true)
    setUploadStatus(null)
    setProgress('')
    setProgressPct(null)
    setCompletedUploadId(null)
    setShowProcessChoice(false)
    setPendingUploadId(null)
    profileChoiceOfferedForUploadRef.current = null

    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('tenantId', selectedTenantId)
      formData.append('fileSize', String(file.size))

      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      })

      if (res.ok || res.status === 202) {
        const data = await res.json()
        setFile(null)
        const fileInput = document.getElementById('file') as HTMLInputElement
        if (fileInput) fileInput.value = ''
        if (data.status === 'processing' || res.status === 202) {
          void pollUploadStatus(data.id, selectedTenantId)
          return
        }
        if (data.status === 'completed') {
          setProgress(`Processing complete! Processed ${data.rowCount ?? 0} rows.`)
          setProgressPct(100)
          setProcessing(false)
          setCompletedUploadId(data.id)
          return
        }
        if (data.status === 'error') {
          setProgress(`Error: ${data.error || 'Unknown error'}`)
          return
        }
      } else {
        const error = await res.json()
        setProgress(`Upload failed: ${error.error || 'Unknown error'}`)
      }
    } catch (error) {
      console.error('Error uploading file:', error)
      setProgress('Upload failed. Please try again.')
    } finally {
      setUploading(false)
    }
  }

  const goToDashboardWhileProcessing = () => {
    if (!selectedTenantId) return
    setShowProcessChoice(false)
    setProcessing(false)
    setPendingUploadId(null)
    setUploadStatus(null)
    setProgress('')
    setProgressPct(null)
    router.push(`/dashboard/${selectedTenantId}`)
  }

  const waitForProgressHere = () => {
    if (!pendingUploadId) return
    setShowProcessChoice(false)
    void pollUploadStatus(pendingUploadId, selectedTenantId)
  }

  const showOverlay =
    uploading || showProcessChoice || (processing && uploadStatus?.status !== 'completed')

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="mb-6 text-2xl font-bold text-gray-900">Upload CSV</h1>

      {showOverlay && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-8 shadow-xl">
            {showProcessChoice ? (
              <div className="text-center">
                <h2 className="mb-3 text-xl font-semibold text-gray-900">Visitor profiles are starting</h2>
                <p className="mb-2 text-left text-sm leading-relaxed text-gray-600">
                  Row ingestion is done — this phase can still take a long time (sometimes an hour or more)
                  while we build visitor profiles on the server. You can leave this page if you prefer.
                </p>
                <p className="mb-6 text-left text-sm text-gray-600">What would you like to do?</p>
                <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
                  <button
                    type="button"
                    onClick={waitForProgressHere}
                    className="rounded-md px-4 py-2.5 text-sm font-medium text-white btn-primary-blue"
                  >
                    Wait here and watch progress
                  </button>
                  <button
                    type="button"
                    onClick={goToDashboardWhileProcessing}
                    className="rounded-md border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-800 shadow-sm hover:bg-gray-50"
                  >
                    Go to dashboard
                  </button>
                </div>
                <p className="mt-4 text-xs text-gray-500">
                  You can return to this upload page later to see status if you leave.
                </p>
              </div>
            ) : (
              <div className="text-center">
                <div className="mb-4">
                  <div
                    className="mx-auto h-12 w-12 animate-spin rounded-full border-4"
                    style={{
                      borderColor: 'rgba(29, 110, 149, 0.2)',
                      borderTopColor: '#1D6E95',
                    }}
                  />
                </div>
                <h2 className="mb-2 text-xl font-semibold text-gray-900">
                  {uploading
                    ? 'Uploading...'
                    : (uploadStatus?.visitorProfileTotal != null && uploadStatus.visitorProfileTotal > 0
                        ? 'Building visitor profiles'
                        : 'Processing CSV')}
                </h2>
                <p className="mb-2 text-sm text-gray-600">{progress || 'Please wait...'}</p>
                {progressPct != null && (
                  <div className="mb-4 w-full rounded-full bg-gray-200">
                    <div
                      className="h-2 rounded-full transition-all duration-500 ease-out"
                      style={{ width: `${progressPct}%`, backgroundColor: '#1D6E95' }}
                    />
                  </div>
                )}
                {uploadStatus && (
                  <div className="mt-4 rounded-md bg-gray-50 p-3 text-left">
                    <div className="text-xs text-gray-500">Status: {uploadStatus.status}</div>
                    {uploadStatus.rowCount !== null && (
                      <div className="text-xs text-gray-500">Rows: {uploadStatus.rowCount}</div>
                    )}
                  </div>
                )}
                {processing && !uploadStatus?.error && !uploading && (
                  <p className="mt-4 text-xs text-gray-500">
                    This may take a long time for very large files — you can stay here or return from the
                    upload page.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="rounded-lg border bg-white p-6 shadow">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="tenant" className="block text-sm font-medium text-gray-700">
              Client *
            </label>
            <select
              id="tenant"
              required
              value={selectedTenantId}
              onChange={(e) => setSelectedTenantId(e.target.value)}
              disabled={uploading || processing || showProcessChoice}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:outline-none focus:border-[#1D6E95] focus:ring-1 focus:ring-[#1D6E95] disabled:bg-gray-100"
            >
              <option value="">Select a client</option>
              {tenants.map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="file" className="block text-sm font-medium text-gray-700">
              CSV File *
            </label>
            <input
              type="file"
              id="file"
              required
              accept=".csv"
              onChange={handleFileChange}
              disabled={uploading || processing || showProcessChoice}
              className="mt-1 block w-full text-sm text-gray-500 file:mr-4 file:rounded-md file:border-0 file:px-4 file:py-2 file:text-sm file:font-semibold file:bg-[rgba(29,110,149,0.1)] file:text-[#1D6E95] hover:file:bg-[rgba(29,110,149,0.15)] disabled:opacity-50"
            />
            {file && (
              <p className="mt-2 text-sm text-gray-600">
                Selected: {file.name} ({(file.size / 1024 / 1024).toFixed(2)} MB)
              </p>
            )}
          </div>

          <button
            type="submit"
            disabled={uploading || processing || showProcessChoice || !file || !selectedTenantId}
            className="rounded-md px-4 py-2 text-white disabled:bg-gray-400 disabled:opacity-50 btn-primary-blue"
          >
            {uploading ? 'Uploading...' : processing ? 'Processing...' : 'Upload & Process'}
          </button>
        </form>
      </div>

      {completedUploadId && selectedTenantId && (
        <div className="mt-8">
          <div className="mb-4 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
            Upload complete. Redirecting to dashboard to generate AI summary...
          </div>
          <h2 className="mb-4 text-lg font-semibold text-gray-900">Revenue estimate</h2>
          <RevenueEstimator uploadId={completedUploadId} tenantId={selectedTenantId} />
          <div className="mt-6">
            <Link
              href={`/dashboard/${selectedTenantId}`}
              className="inline-flex items-center rounded-md px-4 py-2 text-sm font-medium text-white btn-primary-blue"
            >
              Go to Dashboard →
            </Link>
          </div>
        </div>
      )}

      <div className="mt-8">
        <h2 className="mb-4 text-lg font-semibold">Upload Instructions</h2>
        <div className="rounded-lg border bg-gray-50 p-4">
          <ul className="list-disc space-y-2 pl-5 text-sm text-gray-700">
            <li>
              <strong>Smart Pixel V3</strong> exports include <code className="text-xs">EVENT_DATA</code>,{' '}
              <code className="text-xs">EVENT_TYPE</code>, <code className="text-xs">IP_ADDRESS</code>, and
              behavioral timestamps. <strong>V4</strong> exports use <code className="text-xs">FULL_URL</code>,{' '}
              <code className="text-xs">REFERRER_URL</code>, and <code className="text-xs">EVENT_TIMESTAMP</code>{' '}
              (no <code className="text-xs">EVENT_DATA</code> column). The uploader detects V3 vs V4 automatically.
            </li>
            <li>
              Revenue estimates use <strong>all completed uploads</strong> for the selected client (V3 and V4
              together), with visitors deduplicated by pixel id hash / keys.
            </li>
            <li>
              Row upload runs first; when visitor-profile building begins you may choose to watch progress
              here or continue on the dashboard while the server finishes
            </li>
            <li>When processing finishes, a revenue estimate from your pixel data appears below</li>
            <li>Use <strong>Go to Dashboard</strong> when you are ready to leave this page</li>
            <li>System will automatically geolocate IPs, compute scores, and generate AI summaries</li>
          </ul>
        </div>
      </div>
    </div>
  )
}
