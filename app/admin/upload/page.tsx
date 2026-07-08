'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import RevenueEstimator from '@/components/RevenueEstimator'
import {
  shouldUseChunkedUpload,
  uploadCsvInChunks,
} from '@/lib/csv-chunk-upload-client'

interface Tenant {
  id: string
  name: string
  domain: string | null
  showFinancialInsights?: boolean
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
  jobProgress?: {
    mode: 'chunked'
    phase: string | null
    chunksReceived: number
    totalChunks: number | null
  } | null
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
  const [statusBanner, setStatusBanner] = useState<{
    type: 'info' | 'error' | 'success'
    text: string
  } | null>(null)
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

  const patchTenantFinancial = async (tenantId: string, showFinancialInsights: boolean) => {
    const res = await fetch(`/api/tenants/${tenantId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ showFinancialInsights }),
    })
    if (res.ok) await fetchTenants()
    else {
      const err = await res.json().catch(() => ({}))
      alert((err as { error?: string }).error || 'Could not update setting')
    }
  }

  const selectedTenantShowsFinancial = () => {
    const t = tenants.find((x) => x.id === selectedTenantId)
    return t?.showFinancialInsights !== false
  }

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
        setStatusBanner({
          type: 'success',
          text: `Processing complete — ${(status.rowCount || 0).toLocaleString()} rows.`,
        })
        return
      }

      if (status.status === 'error') {
        setProgressPct(null)
        const msg = status.error || 'Unknown error'
        setProgress(`Error: ${msg}`)
        setStatusBanner({ type: 'error', text: msg })
        setProcessing(false)
        return
      }

      if (status.status === 'pending') {
        const jp = status.jobProgress
        if (jp?.mode === 'chunked' && jp.totalChunks) {
          const pct = Math.min(99, Math.round((jp.chunksReceived / jp.totalChunks) * 100))
          setProgressPct(pct)
          setProgress(
            jp.chunksReceived >= jp.totalChunks
              ? 'All parts received — server is ingesting rows…'
              : `Receiving file parts… ${jp.chunksReceived} of ${jp.totalChunks}`
          )
        } else {
          setProgress('Waiting for upload to start…')
        }
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
    setProgress('Sending file to server…')
    setProgressPct(null)
    setCompletedUploadId(null)
    setShowProcessChoice(false)
    setPendingUploadId(null)
    profileChoiceOfferedForUploadRef.current = null
    const sizeMb = (file.size / 1024 / 1024).toFixed(2)
    const useChunks = shouldUseChunkedUpload(file.size)
    setStatusBanner({
      type: 'info',
      text: useChunks
        ? `Uploading "${file.name}" (${sizeMb} MB) in parts for large-file support. Keep this tab open until processing completes.`
        : `Uploading "${file.name}" (${sizeMb} MB). Large files can take several minutes on Vercel — keep this tab open until you see progress or completion.`,
    })

    try {
      if (useChunks) {
        const result = await uploadCsvInChunks(file, selectedTenantId, (p) => {
          if (p.phase === 'chunks' && p.chunkIndex && p.totalChunks) {
            setProgress(`Uploading part ${p.chunkIndex} of ${p.totalChunks}…`)
            setProgressPct(Math.min(99, Math.round((p.chunkIndex / p.totalChunks) * 100)))
          } else if (p.phase === 'init') {
            setProgress('Preparing chunked upload…')
          }
        })

        setFile(null)
        const fileInput = document.getElementById('file') as HTMLInputElement
        if (fileInput) fileInput.value = ''
        setStatusBanner({
          type: 'info',
          text: `All ${result.totalChunks} parts uploaded (ID: ${result.uploadId.slice(0, 8)}…). Server is ingesting and building profiles — progress will update below.`,
        })
        void pollUploadStatus(result.uploadId, selectedTenantId)
        return
      }

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
          setStatusBanner({
            type: 'info',
            text: `Upload accepted (ID: ${data.id.slice(0, 8)}…). Processing rows on the server — progress will update below.`,
          })
          void pollUploadStatus(data.id, selectedTenantId)
          return
        }
        if (data.status === 'completed') {
          setProgress(`Processing complete! Processed ${data.rowCount ?? 0} rows.`)
          setProgressPct(100)
          setProcessing(false)
          setCompletedUploadId(data.id)
          setStatusBanner({
            type: 'success',
            text: `Upload complete — ${data.rowCount ?? 0} rows processed.`,
          })
          return
        }
        if (data.status === 'error') {
          const msg = data.error || 'Unknown error'
          setProgress(`Error: ${msg}`)
          setStatusBanner({ type: 'error', text: msg })
          return
        }
      } else {
        const error = await res.json().catch(() => ({}))
        const msg = (error as { error?: string }).error || `Server error (${res.status})`
        if (res.status === 413 && file && selectedTenantId) {
          setStatusBanner({
            type: 'info',
            text: 'Single-request limit hit — retrying as a multi-part upload…',
          })
          const result = await uploadCsvInChunks(file, selectedTenantId, (p) => {
            if (p.phase === 'chunks' && p.chunkIndex && p.totalChunks) {
              setProgress(`Uploading part ${p.chunkIndex} of ${p.totalChunks}…`)
              setProgressPct(Math.min(99, Math.round((p.chunkIndex / p.totalChunks) * 100)))
            }
          })
          setFile(null)
          const fileInput = document.getElementById('file') as HTMLInputElement
          if (fileInput) fileInput.value = ''
          setStatusBanner({
            type: 'info',
            text: `All ${result.totalChunks} parts uploaded. Server is processing — progress will update below.`,
          })
          void pollUploadStatus(result.uploadId, selectedTenantId)
          return
        }
        setProgress(`Upload failed: ${msg}`)
        setStatusBanner({
          type: 'error',
          text:
            res.status === 413
              ? 'File too large for a single request — retrying with chunked upload should happen automatically for files over 3.5 MB.'
              : msg,
        })
      }
    } catch (error) {
      console.error('Error uploading file:', error)
      const msg =
        'Upload failed — the connection may have timed out (common for large files on Vercel). Check Admin → refresh, or try again with a smaller file.'
      setProgress(msg)
      setStatusBanner({ type: 'error', text: msg })
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

      {statusBanner && (
        <div
          className={`mb-4 rounded-lg border px-4 py-3 text-sm ${
            statusBanner.type === 'error'
              ? 'border-red-200 bg-red-50 text-red-900'
              : statusBanner.type === 'success'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                : 'border-blue-200 bg-blue-50 text-blue-900'
          }`}
          role="status"
        >
          {statusBanner.text}
        </div>
      )}

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

          <div className="mb-6 flex flex-col gap-3 rounded-lg border border-gray-200 bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-800">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-gray-300 text-[#1D6E95] focus:ring-[#1D6E95]"
                checked={selectedTenantShowsFinancial()}
                onChange={(e) =>
                  void patchTenantFinancial(selectedTenantId, e.target.checked)
                }
              />
              <span>
                <strong>Show revenue &amp; financial forecasts</strong> for this client (dashboard KPI
                revenue, ROI forecast, upload revenue estimate). Turn off for a simplified view.
              </span>
            </label>
          </div>

          {selectedTenantShowsFinancial() && (
            <>
              <h2 className="mb-4 text-lg font-semibold text-gray-900">Revenue estimate</h2>
              <RevenueEstimator uploadId={completedUploadId} tenantId={selectedTenantId} />
            </>
          )}
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
              behavioral timestamps.               <strong>V4</strong> exports use <code className="text-xs">FULL_URL</code>,{' '}
              <code className="text-xs">REFERRER_URL</code>, and <code className="text-xs">EVENT_TIMESTAMP</code>, plus
              an <code className="text-xs">EVENTS</code> JSON column (page views, deep scroll, form submit, exit intent,
              etc.) when Audience Lab includes behavioral data. The uploader expands <code className="text-xs">EVENTS</code>{' '}
              into full timelines and detects V3 vs V4 automatically.
            </li>
            <li>
              Files over <strong>3.5 MB</strong> upload in multiple parts automatically (supports very
              large exports — 50k+ rows). Processing continues via background jobs on Vercel.
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
