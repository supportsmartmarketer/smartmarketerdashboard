import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

const uploadSelectFull = {
  id: true,
  status: true,
  rowCount: true,
  processedRows: true,
  fileSizeBytes: true,
  error: true,
  processedAt: true,
  tenantId: true,
  dataStartDate: true,
  dataEndDate: true,
  totalEvents: true,
  uniqueVisitors: true,
  highIntentCount: true,
  visitorProfileTotal: true,
  visitorProfileProcessed: true,
  pixelFormat: true,
} as const

const uploadSelectLegacy = {
  id: true,
  status: true,
  rowCount: true,
  processedRows: true,
  fileSizeBytes: true,
  error: true,
  processedAt: true,
  tenantId: true,
} as const

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ uploadId: string }> }
) {
  try {
    const { uploadId } = await params
    const tenantId = request.nextUrl.searchParams.get('tenantId')

    let upload: Record<string, unknown> | null = null
    try {
      upload = (await prisma.upload.findUnique({
        where: { id: uploadId },
        select: uploadSelectFull,
      })) as Record<string, unknown> | null
    } catch {
      const legacy = await prisma.upload.findUnique({
        where: { id: uploadId },
        select: uploadSelectLegacy,
      })
      if (!legacy) {
        upload = null
      } else {
        let uniqueVisitors: number | null = null
        try {
          const keyRows = await prisma.rawEvent.findMany({
            where: { uploadId, tenantId: legacy.tenantId, visitorKey: { not: 'unknown' } },
            distinct: ['visitorKey'],
            select: { visitorKey: true },
          })
          uniqueVisitors = keyRows.length
        } catch {
          uniqueVisitors = null
        }
        upload = {
          ...legacy,
          dataStartDate: null,
          dataEndDate: null,
          totalEvents: legacy.rowCount ?? null,
          uniqueVisitors,
          highIntentCount: null,
          visitorProfileTotal: null,
          visitorProfileProcessed: null,
          pixelFormat: null,
        }
      }
    }

    if (!upload) {
      return NextResponse.json({ error: 'Upload not found' }, { status: 404 })
    }

    if (tenantId && upload.tenantId !== tenantId) {
      return NextResponse.json({ error: 'Upload does not belong to this client' }, { status: 403 })
    }

    return NextResponse.json(upload)
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
