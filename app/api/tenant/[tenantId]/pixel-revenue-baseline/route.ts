import { NextRequest, NextResponse } from 'next/server'
import { getTenantPixelRevenueBaseline } from '@/lib/tenant-pixel-baseline'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
) {
  try {
    const { tenantId } = await params
    const baseline = await getTenantPixelRevenueBaseline(tenantId)
    return NextResponse.json({
      ...baseline,
      dataStartDate: baseline.dataStartDate?.toISOString() ?? null,
      dataEndDate: baseline.dataEndDate?.toISOString() ?? null,
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('not found')) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 404 })
    }
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
