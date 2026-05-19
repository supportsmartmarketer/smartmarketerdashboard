import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

/**
 * DELETE — Remove all analytics/upload data for a tenant while keeping the client row
 * (name, domain, showFinancialInsights). Upload deletion cascades raw_events.
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

    await prisma.$transaction([
      prisma.tenantSummary.deleteMany({ where: { tenantId: id } }),
      prisma.visitorProfile.deleteMany({ where: { tenantId: id } }),
      prisma.upload.deleteMany({ where: { tenantId: id } }),
    ])

    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    console.error('Error clearing tenant data:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to clear client data' },
      { status: 500 }
    )
  }
}
