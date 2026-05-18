import { randomUUID } from 'crypto'
import { prisma } from '@/lib/prisma'
import type { Prisma, Upload } from '@prisma/client'

function bareUploadRow(
  id: string,
  tenantId: string,
  filename: string,
  fileSizeBytes?: number | null
): Upload {
  return {
    id,
    tenantId,
    filename,
    status: 'processing',
    rowCount: null,
    processedRows: null,
    fileSizeBytes: fileSizeBytes ?? null,
    createdAt: new Date(),
    processedAt: null,
    error: null,
    dataStartDate: null,
    dataEndDate: null,
    totalEvents: null,
    uniqueVisitors: null,
    highIntentCount: null,
    visitorProfileTotal: null,
    visitorProfileProcessed: null,
    pixelFormat: null,
    ingestAux: null,
  }
}

/**
 * Prisma `create()` uses INSERT … RETURNING for all schema columns. If the DB is behind migrations,
 * raw SQL only touches columns that exist on typical `uploads` tables.
 */
async function createUploadRawSql(
  tenantId: string,
  filename: string,
  fileSizeBytes?: number
): Promise<Upload> {
  const id = randomUUID()

  const tries: Array<{
    label: string
    fileSize: number | null
    run: () => Promise<Array<{ id: string }>>
  }> = []

  if (fileSizeBytes != null && fileSizeBytes > 0) {
    tries.push({
      label: 'id+tenant+filename+status+file_size_bytes',
      fileSize: fileSizeBytes,
      run: () =>
        prisma.$queryRaw<Array<{ id: string }>>`
          INSERT INTO uploads (id, tenant_id, filename, status, file_size_bytes)
          VALUES (${id}, ${tenantId}, ${filename}, 'processing', ${fileSizeBytes})
          RETURNING id
        `,
    })
  }

  tries.push({
    label: 'id+tenant+filename+status',
    fileSize: null,
    run: () =>
      prisma.$queryRaw<Array<{ id: string }>>`
        INSERT INTO uploads (id, tenant_id, filename, status)
        VALUES (${id}, ${tenantId}, ${filename}, 'processing')
        RETURNING id
      `,
  })

  tries.push({
    label: 'tenant+filename+status (only if id has DB default)',
    fileSize: null,
    run: () =>
      prisma.$queryRaw<Array<{ id: string }>>`
        INSERT INTO uploads (tenant_id, filename, status)
        VALUES (${tenantId}, ${filename}, 'processing')
        RETURNING id
      `,
  })

  let last: unknown
  for (const t of tries) {
    try {
      const rows = await t.run()
      const outId = rows[0]?.id
      if (!outId) throw new Error('RETURNING id empty')
      console.warn(
        `[upload] created upload row via raw SQL (${t.label}); run prisma db push if schema drift persists.`
      )
      return bareUploadRow(String(outId), tenantId, filename, t.fileSize ?? undefined)
    } catch (e) {
      last = e
      const msg = e instanceof Error ? e.message : String(e)
      console.warn(`[upload] raw insert (${t.label}) failed:`, msg.split('\n')[0]?.slice(0, 240))
    }
  }
  throw last
}

/**
 * Create upload row; fall back to raw SQL when ORM create fails (schema drift).
 */
export async function createUploadRecordResilient(input: {
  tenantId: string
  filename: string
  fileSizeBytes: number | null | undefined
}): Promise<Upload> {
  const { tenantId, filename } = input
  const size =
    input.fileSizeBytes != null && input.fileSizeBytes > 0 ? input.fileSizeBytes : undefined

  type Attempt = Pick<Prisma.UploadUncheckedCreateInput, 'tenantId' | 'filename' | 'status'> & {
    fileSizeBytes?: number
  }

  const minimal: Attempt = { tenantId, filename, status: 'processing' }
  const attempts: Attempt[] = size != null ? [{ ...minimal, fileSizeBytes: size }, minimal] : [minimal]

  let lastError: unknown
  for (let i = 0; i < attempts.length; i++) {
    const d = attempts[i]
    try {
      const data: Prisma.UploadUncheckedCreateInput = {
        tenantId: d.tenantId,
        filename: d.filename,
        status: d.status,
      }
      if (d.fileSizeBytes != null) data.fileSizeBytes = d.fileSizeBytes

      return await prisma.upload.create({ data })
    } catch (e) {
      lastError = e
      const msg = e instanceof Error ? e.message : String(e)
      console.warn(
        `[upload] create attempt ${i + 1}/${attempts.length} failed:`,
        msg.split('\n')[0]?.slice(0, 220)
      )
    }
  }

  try {
    return await createUploadRawSql(tenantId, filename, size)
  } catch (rawErr) {
    console.error('[upload] raw SQL fallback exhausted; check DB and prisma/schema.prisma.')
    throw lastError ?? rawErr
  }
}
