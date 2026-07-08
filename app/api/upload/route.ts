import { after, NextRequest, NextResponse } from 'next/server'
import { Readable } from 'stream'
import Busboy from 'busboy'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { randomUUID } from 'crypto'
import { prisma } from '@/lib/prisma'
import { processCSVUploadFromStream } from '@/lib/csv-processor'
import { createUploadRecordResilient } from '@/lib/upload-create-compat'

/** Large CSV ingest + profiles can run several minutes on Vercel Pro. */
export const maxDuration = 300
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get('content-type') || ''
    if (!contentType.includes('multipart/form-data')) {
      return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 })
    }

    const { tenantId, filename, fileSizeBytes, tempPath } = await new Promise<{
      tenantId: string
      filename: string
      fileSizeBytes: number | null
      tempPath: string
    }>((resolve, reject) => {
      const bb = Busboy({ headers: { 'content-type': contentType } })
      let tenantId = ''
      let fileSizeBytes: number | null = null
      let fileReceived = false

      bb.on('field', (name: string, val: string) => {
        if (name === 'tenantId') tenantId = val
        if (name === 'fileSize') {
          const n = parseInt(val, 10)
          if (!Number.isNaN(n) && n > 0) fileSizeBytes = n
        }
      })

      bb.on('file', (name: string, stream: Readable, info: { filename: string }) => {
        if (name !== 'file') {
          stream.resume()
          return
        }
        fileReceived = true
        const tempPath = path.join(os.tmpdir(), `upload-${randomUUID()}.csv`)
        const writeStream = fs.createWriteStream(tempPath)
        stream.pipe(writeStream)
        writeStream.on('finish', () => {
          writeStream.close(() =>
            resolve({ tenantId, filename: info.filename, fileSizeBytes, tempPath })
          )
        })
        writeStream.on('error', (err) => {
          fs.unlink(tempPath, () => {})
          reject(err)
        })
      })

      bb.on('finish', () => {
        if (!fileReceived) reject(new Error('No file field found in form data'))
      })

      bb.on('error', (err: Error) => reject(err))

      Readable.fromWeb(request.body as any).pipe(bb)
    })

    if (!tenantId) {
      fs.unlink(tempPath, () => {})
      return NextResponse.json({ error: 'tenantId is required' }, { status: 400 })
    }

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } })
    if (!tenant) {
      fs.unlink(tempPath, () => {})
      return NextResponse.json({ error: 'Tenant not found' }, { status: 404 })
    }

    const upload = await createUploadRecordResilient({
      tenantId,
      filename,
      fileSizeBytes,
    })

    const processFromTemp = async () => {
      const readStream = fs.createReadStream(tempPath)
      try {
        const result = await processCSVUploadFromStream(tenantId, upload.id, readStream)
        console.log(`Upload ${upload.id} processed:`, result)
      } catch (error: unknown) {
        console.error(`Upload ${upload.id} failed:`, error)
        const msg = error instanceof Error ? error.message : 'Processing failed'
        await prisma.upload
          .update({
            where: { id: upload.id },
            data: { status: 'error', error: msg },
          })
          .catch(() => {})
      } finally {
        fs.unlink(tempPath, () => {})
      }
    }

    // Keep processing alive after 202 on Vercel/serverless (Render ignores `after`).
    after(() => processFromTemp())

    return NextResponse.json(
      { id: upload.id, status: 'processing', message: 'Upload accepted; processing in background.' },
      { status: 202 }
    )
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
