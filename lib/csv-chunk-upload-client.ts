/** Client-side CSV splitter for Vercel's ~4.5MB request limit. */

/** Use chunked upload when file exceeds this size (bytes). */
export const CHUNKED_UPLOAD_THRESHOLD_BYTES = 3.5 * 1024 * 1024

/** Max bytes per HTTP chunk (under Vercel 4.5MB limit including multipart overhead). */
export const CSV_CHUNK_TARGET_BYTES = 3 * 1024 * 1024

export function shouldUseChunkedUpload(fileSizeBytes: number): boolean {
  return fileSizeBytes > CHUNKED_UPLOAD_THRESHOLD_BYTES
}

/**
 * Split CSV text into chunks on newline boundaries. Each chunk includes the header row
 * so the server can parse it independently.
 */
export function splitCsvTextIntoChunks(text: string, maxChunkBytes = CSV_CHUNK_TARGET_BYTES): string[] {
  const normalized = text.replace(/\r\n/g, '\n')
  const firstNl = normalized.indexOf('\n')
  if (firstNl === -1) return [normalized]

  const header = normalized.slice(0, firstNl + 1)
  const body = normalized.slice(firstNl + 1)
  if (!body.trim()) return [header]

  const chunks: string[] = []
  let start = 0

  while (start < body.length) {
    let end = Math.min(start + maxChunkBytes, body.length)
    if (end < body.length) {
      const lastNl = body.lastIndexOf('\n', end)
      if (lastNl > start) {
        end = lastNl + 1
      }
    }
    chunks.push(header + body.slice(start, end))
    start = end
  }

  return chunks.length > 0 ? chunks : [header]
}

export async function splitCsvFileIntoChunks(
  file: File,
  maxChunkBytes = CSV_CHUNK_TARGET_BYTES
): Promise<string[]> {
  const text = await file.text()
  return splitCsvTextIntoChunks(text, maxChunkBytes)
}

export type ChunkUploadProgress = {
  phase: 'init' | 'chunks' | 'done'
  chunkIndex?: number
  totalChunks?: number
}

export type ChunkUploadResult = {
  uploadId: string
  status: string
  totalChunks: number
}

/** Upload a large CSV via init + chunk endpoints. */
export async function uploadCsvInChunks(
  file: File,
  tenantId: string,
  onProgress?: (p: ChunkUploadProgress) => void
): Promise<ChunkUploadResult> {
  const chunks = await splitCsvFileIntoChunks(file)
  onProgress?.({ phase: 'init', totalChunks: chunks.length })

  const initRes = await fetch('/api/upload/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenantId,
      filename: file.name,
      fileSizeBytes: file.size,
      totalChunks: chunks.length,
    }),
  })

  if (!initRes.ok) {
    const err = await initRes.json().catch(() => ({}))
    throw new Error((err as { error?: string }).error || `Init failed (${initRes.status})`)
  }

  const initData = (await initRes.json()) as { id: string; status: string }

  for (let i = 0; i < chunks.length; i++) {
    onProgress?.({ phase: 'chunks', chunkIndex: i + 1, totalChunks: chunks.length })

    const blob = new Blob([chunks[i]], { type: 'text/csv' })
    const formData = new FormData()
    formData.append('uploadId', initData.id)
    formData.append('tenantId', tenantId)
    formData.append('chunkIndex', String(i))
    formData.append('totalChunks', String(chunks.length))
    formData.append('chunk', blob, `part-${i + 1}.csv`)

    const chunkRes = await fetch('/api/upload/chunk', {
      method: 'POST',
      body: formData,
    })

    if (!chunkRes.ok) {
      const err = await chunkRes.json().catch(() => ({}))
      throw new Error(
        (err as { error?: string }).error || `Chunk ${i + 1}/${chunks.length} failed (${chunkRes.status})`
      )
    }
  }

  onProgress?.({ phase: 'done', totalChunks: chunks.length })
  return {
    uploadId: initData.id,
    status: 'processing',
    totalChunks: chunks.length,
  }
}
