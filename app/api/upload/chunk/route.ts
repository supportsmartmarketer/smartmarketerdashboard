import { after, NextRequest, NextResponse } from 'next/server'
import { Readable } from 'stream'
import Busboy from 'busboy'
import { prisma } from '@/lib/prisma'
import { saveUploadChunk } from '@/lib/upload-chunk-store'
import {
  chunkReceiveComplete,
  markChunkReceived,
  parseUploadJobState,
  serializeUploadJobState,
} from '@/lib/upload-job-state'
import { kickChunkedUploadProcessing } from '@/lib/upload-job-processor'

export const maxDuration = 300
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get('content-type') || ''
    if (!contentType.includes('multipart/form-data')) {
      return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 })
    }

    const parsed = await new Promise<{
      uploadId: string
      tenantId: string
      chunkIndex: number
      totalChunks: number
      content: string
    }>((resolve, reject) => {
      const bb = Busboy({ headers: { 'content-type': contentType } })
      let uploadId = ''
      let tenantId = ''
      let chunkIndex = -1
      let totalChunks = 0
      let fileReceived = false
      const chunks: Buffer[] = []

      bb.on('field', (name: string, val: string) => {
        if (name === 'uploadId') uploadId = val
        if (name === 'tenantId') tenantId = val
        if (name === 'chunkIndex') chunkIndex = parseInt(val, 10)
        if (name === 'totalChunks') totalChunks = parseInt(val, 10)
      })

      bb.on('file', (name: string, stream: Readable) => {
        if (name !== 'chunk') {
          stream.resume()
          return
        }
        fileReceived = true
        stream.on('data', (d: Buffer) => chunks.push(d))
        stream.on('error', reject)
      })

      bb.on('finish', () => {
        if (!fileReceived) {
          reject(new Error('No chunk file found in form data'))
          return
        }
        resolve({
          uploadId,
          tenantId,
          chunkIndex,
          totalChunks,
          content: Buffer.concat(chunks).toString('utf8'),
        })
      })

      bb.on('error', reject)
      Readable.fromWeb(request.body as any).pipe(bb)
    })

    if (!parsed.uploadId || !parsed.tenantId) {
      return NextResponse.json({ error: 'uploadId and tenantId are required' }, { status: 400 })
    }
    if (parsed.chunkIndex < 0 || Number.isNaN(parsed.chunkIndex)) {
      return NextResponse.json({ error: 'chunkIndex is required' }, { status: 400 })
    }

    const upload = await prisma.upload.findUnique({
      where: { id: parsed.uploadId },
      select: { id: true, tenantId: true, status: true, ingestAux: true },
    })

    if (!upload) {
      return NextResponse.json({ error: 'Upload not found' }, { status: 404 })
    }
    if (upload.tenantId !== parsed.tenantId) {
      return NextResponse.json({ error: 'Upload does not belong to this client' }, { status: 403 })
    }

    let state = parseUploadJobState(upload.ingestAux)
    if (!state || state.mode !== 'chunked') {
      return NextResponse.json({ error: 'Upload is not a chunked job' }, { status: 400 })
    }

    const phase = state.phase ?? 'receiving'
    const alreadyHadChunk = state.receivedChunks?.includes(parsed.chunkIndex) ?? false
    if (phase !== 'receiving' && !alreadyHadChunk) {
      return NextResponse.json({ error: 'Upload no longer accepting new chunks' }, { status: 409 })
    }

    if (upload.status !== 'pending' && upload.status !== 'processing') {
      return NextResponse.json({ error: `Upload is ${upload.status}` }, { status: 409 })
    }

    const expectedTotal = state.totalChunks ?? parsed.totalChunks
    if (parsed.chunkIndex >= expectedTotal) {
      return NextResponse.json({ error: 'chunkIndex out of range' }, { status: 400 })
    }

    if (!parsed.content.trim()) {
      return NextResponse.json({ error: 'Chunk content is empty' }, { status: 400 })
    }

    await saveUploadChunk(parsed.uploadId, parsed.chunkIndex, parsed.content)
    state = markChunkReceived(state, parsed.chunkIndex)

    const allReceived = chunkReceiveComplete(state)
    const nextStatus = allReceived ? 'processing' : 'pending'
    const nextPhase = allReceived ? 'ingest' : state.phase

    await prisma.upload.update({
      where: { id: parsed.uploadId },
      data: {
        status: nextStatus,
        ingestAux: serializeUploadJobState({
          ...state,
          phase: nextPhase,
        }),
      },
    })

    if (allReceived) {
      after(() => kickChunkedUploadProcessing(parsed.uploadId))
    }

    return NextResponse.json({
      uploadId: parsed.uploadId,
      chunkIndex: parsed.chunkIndex,
      received: state.receivedChunks?.length ?? 0,
      totalChunks: expectedTotal,
      status: nextStatus,
      allReceived,
    })
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Chunk upload failed'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
