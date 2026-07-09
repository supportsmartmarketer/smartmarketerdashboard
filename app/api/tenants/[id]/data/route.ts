import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

/**
 * DELETE — Remove all analytics/upload data for a tenant while keeping the client row.
 * Sequential deletes avoid Prisma's default 5s interactive transaction timeout on large clients.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    if (!id) {
      return NextResponse.json({ error: 'Client ID is required' }, { status: 400 })
    }

    const tenant = await prisma.tenant.findUnique({
      where: { id },
      select: { id: true },
    })
    if (!tenant) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    }

    // Cancel in-flight uploads so cron does not keep writing mid-delete
    await prisma.upload.updateMany({
      where: { tenantId: id, status: { in: ['pending', 'processing'] } },
      data: { status: 'error', error: 'Cancelled — client data was cleared' },
    })

    await prisma.tenantSummary.deleteMany({ where: { tenantId: id } })
    await prisma.visitorProfile.deleteMany({ where: { tenantId: id } })
    // Cascades raw_events, upload_chunks, upload_visitor_identities
    await prisma.upload.deleteMany({ where: { tenantId: id } })

    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    console.error('Error clearing tenant data:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to clear client data' },
      { status: 500 }
    )
  }
}
