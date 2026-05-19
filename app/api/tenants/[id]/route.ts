import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    if (!id) {
      return NextResponse.json({ error: 'Client ID is required' }, { status: 400 })
    }

    const body = (await request.json()) as {
      name?: string
      domain?: string | null
      showFinancialInsights?: boolean
    }

    const data: {
      name?: string
      domain?: string | null
      showFinancialInsights?: boolean
    } = {}

    if (typeof body.name === 'string' && body.name.trim() !== '') {
      data.name = body.name.trim()
    }
    if (body.domain !== undefined) {
      data.domain = typeof body.domain === 'string' && body.domain.trim() !== '' ? body.domain.trim() : null
    }
    if (typeof body.showFinancialInsights === 'boolean') {
      data.showFinancialInsights = body.showFinancialInsights
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
    }

    const tenant = await prisma.tenant.update({
      where: { id },
      data,
    })
    return NextResponse.json(tenant)
  } catch (error: unknown) {
    const e = error as { code?: string }
    if (e.code === 'P2025') {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    }
    console.error('Error updating tenant:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update client' },
      { status: 500 }
    )
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    if (!id) {
      return NextResponse.json({ error: 'Client ID is required' }, { status: 400 })
    }

    await prisma.tenant.delete({
      where: { id },
    })
    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    const e = error as { code?: string }
    if (e.code === 'P2025') {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    }
    console.error('Error deleting tenant:', error)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to delete client' },
      { status: 500 }
    )
  }
}
