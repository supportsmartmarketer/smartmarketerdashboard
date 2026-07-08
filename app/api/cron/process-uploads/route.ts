import { NextRequest, NextResponse } from 'next/server'
import { verifyCronRequest } from '@/lib/cron-auth'
import { processPendingUploadJobs } from '@/lib/upload-job-processor'

export const maxDuration = 800
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  if (!verifyCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await processPendingUploadJobs({ maxMs: 120_000, maxUploads: 3 })
    return NextResponse.json({
      ok: true,
      ...result,
    })
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Cron processing failed'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

/** Allow manual kick from admin tools via POST with cron secret. */
export async function POST(request: NextRequest) {
  return GET(request)
}
