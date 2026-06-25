import { NextRequest, NextResponse } from 'next/server'
import { rebuildTenantVisitorProfiles } from '@/lib/csv-processor'
import { prisma } from '@/lib/prisma'

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    if (!id) {
      return NextResponse.json({ error: 'Client ID is required' }, { status: 400 })
    }

    const tenant = await prisma.tenant.findUnique({ where: { id }, select: { id: true } })
    if (!tenant) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    }

    const result = await rebuildTenantVisitorProfiles(id)
    return NextResponse.json(result)
  } catch (error: unknown) {
    console.error('Error rebuilding profiles:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to rebuild profiles' },
      { status: 500 }
    )
  }
}
