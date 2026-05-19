import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  try {
    const tenants = await prisma.tenant.findMany({
      orderBy: { createdAt: 'desc' },
    })
    return NextResponse.json(tenants)
  } catch (error: any) {
    console.error('Prisma error in GET /api/tenants:', error)
    return NextResponse.json({ 
      error: error.message || 'Database error',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { name, domain } = body

    if (!name) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    }

    const tenant = await prisma.tenant.create({
      data: {
        name,
        domain: domain || null,
        showFinancialInsights: typeof body.showFinancialInsights === 'boolean' ? body.showFinancialInsights : true,
      },
    })

    return NextResponse.json(tenant, { status: 201 })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

