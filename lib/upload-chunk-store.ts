import { randomUUID } from 'crypto'
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@prisma/client'

export async function saveUploadChunk(
  uploadId: string,
  chunkIndex: number,
  content: string
): Promise<void> {
  try {
    await prisma.uploadChunk.upsert({
      where: {
        uploadId_chunkIndex: { uploadId, chunkIndex },
      },
      create: { uploadId, chunkIndex, content },
      update: { content },
    })
    return
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!msg.includes('upload_chunks') && !msg.includes('UploadChunk')) throw e
  }

  await prisma.$executeRaw`
    INSERT INTO upload_chunks (id, upload_id, chunk_index, content)
    VALUES (${randomUUID()}::uuid, ${uploadId}::uuid, ${chunkIndex}, ${content})
    ON CONFLICT (upload_id, chunk_index)
    DO UPDATE SET content = EXCLUDED.content
  `
}

export async function loadUploadChunk(
  uploadId: string,
  chunkIndex: number
): Promise<string | null> {
  try {
    const row = await prisma.uploadChunk.findUnique({
      where: { uploadId_chunkIndex: { uploadId, chunkIndex } },
      select: { content: true },
    })
    if (row) return row.content
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!msg.includes('upload_chunks') && !msg.includes('UploadChunk')) throw e
  }

  const rows = await prisma.$queryRaw<Array<{ content: string }>>`
    SELECT content FROM upload_chunks
    WHERE upload_id::text = ${uploadId} AND chunk_index = ${chunkIndex}
    LIMIT 1
  `
  return rows[0]?.content ?? null
}

export async function deleteUploadChunk(uploadId: string, chunkIndex: number): Promise<void> {
  try {
    await prisma.uploadChunk.deleteMany({ where: { uploadId, chunkIndex } })
    return
  } catch {
    // fall through
  }
  await prisma.$executeRaw`
    DELETE FROM upload_chunks WHERE upload_id::text = ${uploadId} AND chunk_index = ${chunkIndex}
  `
}

export async function saveUploadVisitorIdentity(
  uploadId: string,
  visitorKey: string,
  identity: Record<string, unknown>
): Promise<void> {
  if (!visitorKey || visitorKey === 'unknown' || Object.keys(identity).length === 0) return

  const payload = identity as Prisma.InputJsonValue
  try {
    await prisma.uploadVisitorIdentity.upsert({
      where: {
        uploadId_visitorKey: { uploadId, visitorKey },
      },
      create: { uploadId, visitorKey, identity: payload },
      update: { identity: payload },
    })
    return
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!msg.includes('upload_visitor_identities') && !msg.includes('UploadVisitorIdentity')) {
      throw e
    }
  }

  await prisma.$executeRaw`
    INSERT INTO upload_visitor_identities (upload_id, visitor_key, identity)
    VALUES (${uploadId}::uuid, ${visitorKey}, ${JSON.stringify(identity)}::jsonb)
    ON CONFLICT (upload_id, visitor_key)
    DO UPDATE SET identity = EXCLUDED.identity
  `
}

export async function loadUploadIdentitiesBatch(
  uploadId: string,
  visitorKeys: string[]
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>()
  if (visitorKeys.length === 0) return out

  const CHUNK = 400
  for (let i = 0; i < visitorKeys.length; i += CHUNK) {
    const slice = visitorKeys.slice(i, i + CHUNK)
    try {
      const rows = await prisma.uploadVisitorIdentity.findMany({
        where: { uploadId, visitorKey: { in: slice } },
        select: { visitorKey: true, identity: true },
      })
      for (const row of rows) {
        if (row.identity && typeof row.identity === 'object') {
          out.set(row.visitorKey, row.identity as Record<string, unknown>)
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.includes('upload_visitor_identities') && !msg.includes('UploadVisitorIdentity')) {
        throw e
      }
    }
  }
  return out
}

export async function loadUploadVisitorIdentity(
  uploadId: string,
  visitorKey: string
): Promise<Record<string, unknown> | null> {
  try {
    const row = await prisma.uploadVisitorIdentity.findUnique({
      where: { uploadId_visitorKey: { uploadId, visitorKey } },
      select: { identity: true },
    })
    if (row?.identity && typeof row.identity === 'object') {
      return row.identity as Record<string, unknown>
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!msg.includes('upload_visitor_identities') && !msg.includes('UploadVisitorIdentity')) {
      throw e
    }
  }

  const rows = await prisma.$queryRaw<Array<{ identity: unknown }>>`
    SELECT identity FROM upload_visitor_identities
    WHERE upload_id::text = ${uploadId} AND visitor_key = ${visitorKey}
    LIMIT 1
  `
  const id = rows[0]?.identity
  return id && typeof id === 'object' ? (id as Record<string, unknown>) : null
}
