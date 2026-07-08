import { prisma } from '@/lib/prisma'
import {
  finalizeCompletedUpload,
  getTenantTrackingConfig,
  ingestCsvTextRows,
  mapRawEventToProcessed,
  processVisitorProfile,
  RAW_EVENT_SELECT,
  type IdentityData,
} from '@/lib/csv-processor'
import {
  deleteUploadChunk,
  loadUploadChunk,
  loadUploadVisitorIdentity,
  saveUploadVisitorIdentity,
} from '@/lib/upload-chunk-store'
import {
  chunkReceiveComplete,
  parseUploadJobState,
  serializeUploadJobState,
  type UploadJobState,
} from '@/lib/upload-job-state'

const VISITORS_PER_PROFILE_BATCH = 40
const DEFAULT_MAX_MS = 240_000

async function persistJobState(uploadId: string, state: UploadJobState): Promise<void> {
  await prisma.upload.update({
    where: { id: uploadId },
    data: { ingestAux: serializeUploadJobState(state) },
  })
}

async function tryAcquireJobLock(uploadId: string, state: UploadJobState): Promise<UploadJobState | null> {
  const now = Date.now()
  if (state.lockUntil != null && state.lockUntil > now) {
    return null
  }
  const locked: UploadJobState = { ...state, lockUntil: now + DEFAULT_MAX_MS }
  await persistJobState(uploadId, locked)
  return locked
}

async function releaseJobLock(uploadId: string, state: UploadJobState): Promise<void> {
  await persistJobState(uploadId, { ...state, lockUntil: null })
}

function mergeTsBounds(
  state: UploadJobState,
  minTs: number | null,
  maxTs: number | null
): UploadJobState {
  let nextMin = state.minTs ?? null
  let nextMax = state.maxTs ?? null
  if (minTs != null) nextMin = nextMin == null ? minTs : Math.min(nextMin, minTs)
  if (maxTs != null) nextMax = nextMax == null ? maxTs : Math.max(nextMax, maxTs)
  return { ...state, minTs: nextMin, maxTs: nextMax }
}

function computeWindowFromBounds(minTs: number, maxTs: number) {
  const windowEnd = new Date(maxTs)
  const windowStart = new Date(Math.max(minTs, maxTs - 30 * 24 * 60 * 60 * 1000))
  return { windowStart, windowEnd }
}

async function safeSetVisitorProfileProgress(uploadId: string, processed: number, total: number) {
  try {
    await prisma.upload.update({
      where: { id: uploadId },
      data: { visitorProfileProcessed: processed, visitorProfileTotal: total },
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!msg.includes('visitor_profile')) throw e
  }
}

async function countDistinctVisitors(uploadId: string, tenantId: string): Promise<number> {
  const rows = await prisma.rawEvent.findMany({
    where: { uploadId, tenantId, visitorKey: { not: 'unknown' } },
    distinct: ['visitorKey'],
    select: { visitorKey: true },
  })
  return rows.length
}

async function listVisitorKeysBatch(
  uploadId: string,
  tenantId: string,
  offset: number,
  limit: number
): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ visitor_key: string }>>`
    SELECT DISTINCT visitor_key
    FROM raw_events
    WHERE upload_id = ${uploadId}::uuid
      AND tenant_id = ${tenantId}::uuid
      AND visitor_key <> 'unknown'
    ORDER BY visitor_key
    OFFSET ${offset}
    LIMIT ${limit}
  `
  return rows.map((r) => r.visitor_key)
}

async function ingestOneChunk(
  uploadId: string,
  tenantId: string,
  state: UploadJobState
): Promise<{ state: UploadJobState; ingestComplete: boolean }> {
  const chunkIndex = state.ingestChunkIndex ?? 0
  const totalChunks = state.totalChunks ?? 0
  if (chunkIndex >= totalChunks) {
    return { state, ingestComplete: true }
  }

  const content = await loadUploadChunk(uploadId, chunkIndex)
  if (!content) {
    throw new Error(`Missing chunk ${chunkIndex + 1} of ${totalChunks} for upload ${uploadId}`)
  }

  const pixelFormatAlreadySaved = chunkIndex > 0
  const result = await ingestCsvTextRows(tenantId, uploadId, content, {
    pixelFormatAlreadySaved,
    onIdentity: async (visitorKey, identity) => {
      await saveUploadVisitorIdentity(uploadId, visitorKey, identity as Record<string, unknown>)
    },
  })

  if (result.eventsInserted === 0 && chunkIndex === 0) {
    throw new Error('No valid events found in CSV. Check timestamp columns.')
  }

  await deleteUploadChunk(uploadId, chunkIndex)

  let nextState = mergeTsBounds(state, result.minTs, result.maxTs)
  nextState = {
    ...nextState,
    ingestChunkIndex: chunkIndex + 1,
  }

  const ingestComplete = (nextState.ingestChunkIndex ?? 0) >= totalChunks
  return { state: nextState, ingestComplete }
}

async function beginProfilePhase(
  uploadId: string,
  tenantId: string,
  state: UploadJobState
): Promise<UploadJobState> {
  const minTs = state.minTs
  const maxTs = state.maxTs
  if (minTs == null || maxTs == null) {
    throw new Error('Upload ingest finished without valid event timestamps.')
  }

  const { windowStart, windowEnd } = computeWindowFromBounds(minTs, maxTs)
  const total = await countDistinctVisitors(uploadId, tenantId)
  await safeSetVisitorProfileProgress(uploadId, 0, total)

  return {
    ...state,
    phase: 'profiles',
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
  }
}

async function processProfileBatch(
  uploadId: string,
  tenantId: string,
  state: UploadJobState
): Promise<{ state: UploadJobState; profilesComplete: boolean }> {
  const windowStart = state.windowStart ? new Date(state.windowStart) : null
  const windowEnd = state.windowEnd ? new Date(state.windowEnd) : null
  if (!windowStart || !windowEnd) {
    throw new Error('Profile phase missing window bounds.')
  }

  const upload = await prisma.upload.findUnique({
    where: { id: uploadId },
    select: { visitorProfileProcessed: true, visitorProfileTotal: true },
  })
  const processed = upload?.visitorProfileProcessed ?? 0
  const total = upload?.visitorProfileTotal ?? 0
  if (total === 0) {
    return { state, profilesComplete: true }
  }
  if (processed >= total) {
    return { state, profilesComplete: true }
  }

  const trackingConfig = await getTenantTrackingConfig(tenantId)
  const keys = await listVisitorKeysBatch(uploadId, tenantId, processed, VISITORS_PER_PROFILE_BATCH)
  if (keys.length === 0) {
    return { state, profilesComplete: true }
  }

  let done = processed
  for (const visitorKey of keys) {
    const rawEvents = await prisma.rawEvent.findMany({
      where: { tenantId, uploadId, visitorKey },
      orderBy: { eventTs: 'asc' },
      select: RAW_EVENT_SELECT,
    })
    if (rawEvents.length === 0) {
      done++
      continue
    }

    const storedIdentity = await loadUploadVisitorIdentity(uploadId, visitorKey)
    const preExtractedIdentity = storedIdentity as IdentityData | undefined

    await processVisitorProfile(
      tenantId,
      visitorKey,
      rawEvents.map(mapRawEventToProcessed),
      windowStart,
      windowEnd,
      preExtractedIdentity,
      trackingConfig
    )
    done++
  }

  await safeSetVisitorProfileProgress(uploadId, done, total)
  return { state, profilesComplete: done >= total }
}

async function finalizeChunkedUpload(
  uploadId: string,
  tenantId: string,
  state: UploadJobState
): Promise<void> {
  const minTs = state.minTs
  const maxTs = state.maxTs
  if (minTs == null || maxTs == null) {
    throw new Error('Cannot finalize upload without timestamp bounds.')
  }

  const { windowStart, windowEnd } = computeWindowFromBounds(minTs, maxTs)
  const upload = await prisma.upload.findUnique({
    where: { id: uploadId },
    select: { processedRows: true },
  })
  const totalProcessed = upload?.processedRows ?? 0
  const uniqueVisitorsCount = await countDistinctVisitors(uploadId, tenantId)

  await finalizeCompletedUpload({
    uploadId,
    tenantId,
    totalProcessed,
    minTs,
    maxTs,
    uniqueVisitorsCount,
    windowStart,
    windowEnd,
  })

  await prisma.upload.update({
    where: { id: uploadId },
    data: { ingestAux: null },
  })
}

/**
 * Process the next ingest/profile batches for a chunked upload until maxMs elapses or job completes.
 */
export async function processUploadJobBatch(
  uploadId: string,
  options?: { maxMs?: number }
): Promise<{ processed: boolean; completed: boolean }> {
  const upload = await prisma.upload.findUnique({
    where: { id: uploadId },
    select: {
      id: true,
      tenantId: true,
      status: true,
      ingestAux: true,
    },
  })

  if (!upload) return { processed: false, completed: false }
  if (upload.status === 'completed' || upload.status === 'error') {
    return { processed: false, completed: upload.status === 'completed' }
  }

  let state = parseUploadJobState(upload.ingestAux)
  if (!state || state.mode !== 'chunked') {
    return { processed: false, completed: false }
  }

  if (state.phase === 'receiving' && !chunkReceiveComplete(state)) {
    return { processed: false, completed: false }
  }

  const locked = await tryAcquireJobLock(uploadId, state)
  if (!locked) return { processed: false, completed: false }
  state = locked

  const deadline = Date.now() + (options?.maxMs ?? DEFAULT_MAX_MS)
  let didWork = false

  try {
    if (upload.status === 'pending' && chunkReceiveComplete(state)) {
      await prisma.upload.update({
        where: { id: uploadId },
        data: { status: 'processing' },
      })
      state = { ...state, phase: 'ingest', ingestChunkIndex: state.ingestChunkIndex ?? 0 }
      await persistJobState(uploadId, state)
    }

    if (state.phase === 'ingest' || (state.phase === 'receiving' && chunkReceiveComplete(state))) {
      state = { ...state, phase: 'ingest' }
      while (Date.now() < deadline) {
        const { state: nextState, ingestComplete } = await ingestOneChunk(
          uploadId,
          upload.tenantId,
          state
        )
        state = nextState
        didWork = true
        await persistJobState(uploadId, state)
        if (ingestComplete) {
          state = await beginProfilePhase(uploadId, upload.tenantId, state)
          await persistJobState(uploadId, state)
          break
        }
      }
    }

    if (state.phase === 'profiles' && Date.now() < deadline) {
      while (Date.now() < deadline) {
        const { state: nextState, profilesComplete } = await processProfileBatch(
          uploadId,
          upload.tenantId,
          state
        )
        state = nextState
        didWork = true
        await persistJobState(uploadId, state)
        if (profilesComplete) {
          state = { ...state, phase: 'finalize' }
          await persistJobState(uploadId, state)
          await finalizeChunkedUpload(uploadId, upload.tenantId, state)
          return { processed: true, completed: true }
        }
      }
    }

    const refreshed = await prisma.upload.findUnique({
      where: { id: uploadId },
      select: { status: true },
    })
    return { processed: didWork, completed: refreshed?.status === 'completed' }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Processing failed'
    console.error(`[upload-job] ${uploadId} failed:`, error)
    await prisma.upload.update({
      where: { id: uploadId },
      data: { status: 'error', error: msg },
    }).catch(() => {})
    return { processed: true, completed: false }
  } finally {
    const latest = parseUploadJobState(
      (await prisma.upload.findUnique({ where: { id: uploadId }, select: { ingestAux: true } }))
        ?.ingestAux
    )
    if (latest) {
      await releaseJobLock(uploadId, latest)
    }
  }
}

/** Drain all chunked uploads that need work (for cron). */
export async function processPendingUploadJobs(options?: {
  maxMs?: number
  maxUploads?: number
}): Promise<{ uploadsTouched: number; completed: number }> {
  const maxUploads = options?.maxUploads ?? 3
  const candidates = await prisma.upload.findMany({
    where: {
      status: { in: ['pending', 'processing'] },
      ingestAux: { not: null },
    },
    orderBy: { createdAt: 'asc' },
    take: 20,
    select: { id: true, ingestAux: true },
  })

  let uploadsTouched = 0
  let completed = 0

  for (const row of candidates) {
    const state = parseUploadJobState(row.ingestAux)
    if (!state || state.mode !== 'chunked') continue
    if (state.phase === 'receiving' && !chunkReceiveComplete(state)) continue
    if (uploadsTouched >= maxUploads) break

    const result = await processUploadJobBatch(row.id, { maxMs: options?.maxMs ?? 120_000 })
    if (result.processed) uploadsTouched++
    if (result.completed) completed++
  }

  return { uploadsTouched, completed }
}

/** Call when the final chunk arrives to start processing immediately. */
export async function kickChunkedUploadProcessing(uploadId: string): Promise<void> {
  await processUploadJobBatch(uploadId, { maxMs: DEFAULT_MAX_MS })
}
