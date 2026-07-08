import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { createUploadRecordResilient } from '@/lib/upload-create-compat'
import { createChunkedJobState, serializeUploadJobState } from '@/lib/upload-job-state'

export const maxDuration = 60
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const tenantId = String(body.tenantId || '').trim()
    const filename = String(body.filename || 'upload.csv').trim()
    const fileSizeBytes =
      typeof body.fileSizeBytes === 'number' && body.fileSizeBytes > 0
        ? body.fileSizeBytes
        : null
    const totalChunks =
      typeof body.totalChunks === 'number' && body.totalChunks > 0
        ? Math.floor(body.totalChunks)
        : 0

    if (!tenantId) {
      return NextResponse.json({ error: 'tenantId is required' }, { status: 400 })
    }
    if (totalChunks < 1) {
      return NextResponse.json({ error: 'totalChunks must be at least 1' }, { status: 400 })
    }

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } })
    if (!tenant) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 404 })
    }

    const upload = await createUploadRecordResilient({
      tenantId,
      filename,
      fileSizeBytes,
    })

    const jobState = createChunkedJobState(totalChunks)

    await prisma.upload.update({
      where: { id: upload.id },
      data: {
        status: 'pending',
        ingestAux: serializeUploadJobState(jobState),
      },
    })

    return NextResponse.json({
      id: upload.id,
      status: 'pending',
      totalChunks,
      message: 'Chunked upload initialized. Send CSV parts to /api/upload/chunk.',
    })
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Init failed'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
