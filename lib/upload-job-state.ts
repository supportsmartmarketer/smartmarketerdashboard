/** JSON stored in uploads.ingest_aux for resumable chunked jobs. */
export type UploadJobPhase = 'receiving' | 'ingest' | 'profiles' | 'finalize'

export type UploadJobState = {
  v: 1
  mode: 'single' | 'chunked'
  phase?: UploadJobPhase
  totalChunks?: number
  receivedChunks?: number[]
  ingestChunkIndex?: number
  minTs?: number | null
  maxTs?: number | null
  windowStart?: string | null
  windowEnd?: string | null
  /** Epoch ms — prevents concurrent cron/after workers on same upload */
  lockUntil?: number | null
}

export function parseUploadJobState(ingestAux: string | null | undefined): UploadJobState | null {
  if (!ingestAux?.trim()) return null
  try {
    const parsed = JSON.parse(ingestAux) as UploadJobState
    if (parsed?.v !== 1 || !parsed.mode) return null
    return parsed
  } catch {
    return null
  }
}

export function serializeUploadJobState(state: UploadJobState): string {
  return JSON.stringify(state)
}

export function createChunkedJobState(totalChunks: number): UploadJobState {
  return {
    v: 1,
    mode: 'chunked',
    phase: 'receiving',
    totalChunks,
    receivedChunks: [],
    ingestChunkIndex: 0,
    minTs: null,
    maxTs: null,
    windowStart: null,
    windowEnd: null,
    lockUntil: null,
  }
}

export function chunkReceiveComplete(state: UploadJobState): boolean {
  const total = state.totalChunks ?? 0
  const received = state.receivedChunks?.length ?? 0
  return total > 0 && received >= total
}

export function markChunkReceived(state: UploadJobState, chunkIndex: number): UploadJobState {
  const received = new Set(state.receivedChunks ?? [])
  received.add(chunkIndex)
  return {
    ...state,
    receivedChunks: [...received].sort((a, b) => a - b),
  }
}
