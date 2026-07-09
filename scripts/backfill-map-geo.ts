/**
 * Backfill upload_visitor_identities + profile lat/lng/city/region from profile.identity JSON.
 * Run: npx tsx scripts/backfill-map-geo.ts
 */
import 'dotenv/config'
import { prisma } from '../lib/prisma.js'
import { approximateGeoFromPlace } from '../lib/geo-fallback.js'

async function backfillProfileCoords(tenantId?: string) {
  const where = tenantId ? { tenantId, lat: null } : { lat: null }
  const profiles = await prisma.visitorProfile.findMany({
    where,
    select: {
      id: true,
      tenantId: true,
      visitorKey: true,
      city: true,
      region: true,
      country: true,
      identity: true,
    },
  })

  let updated = 0
  let skipped = 0

  for (const p of profiles) {
    const id = p.identity as Record<string, unknown> | null
    const city =
      p.city ||
      (typeof id?.city === 'string' ? id.city : undefined) ||
      null
    const region =
      p.region ||
      (typeof id?.state === 'string' ? id.state : undefined) ||
      null
    const country =
      p.country ||
      (typeof id?.country === 'string' ? id.country : undefined) ||
      'US'

    const geo = approximateGeoFromPlace(city, region, country, p.visitorKey)
    if (!geo?.lat || !geo?.lng) {
      skipped++
      continue
    }

    await prisma.visitorProfile.update({
      where: { id: p.id },
      data: {
        lat: geo.lat,
        lng: geo.lng,
        city: city || geo.city || null,
        region: region || geo.region || null,
        country: geo.country || country || null,
      },
    })
    updated++
  }

  return { scanned: profiles.length, updated, skipped }
}

async function backfillUploadIdentities() {
  const uploads = await prisma.upload.findMany({
    where: { status: 'completed' },
    select: { id: true, tenantId: true },
    orderBy: { processedAt: 'desc' },
  })

  let inserted = 0

  for (const upload of uploads) {
    const keys = await prisma.rawEvent.findMany({
      where: { uploadId: upload.id, tenantId: upload.tenantId, visitorKey: { not: 'unknown' } },
      distinct: ['visitorKey'],
      select: { visitorKey: true },
    })
    if (keys.length === 0) continue

    const profiles = await prisma.visitorProfile.findMany({
      where: {
        tenantId: upload.tenantId,
        visitorKey: { in: keys.map((k) => k.visitorKey) },
      },
      orderBy: { windowEnd: 'desc' },
      select: { visitorKey: true, identity: true },
    })

    const identityByKey = new Map<string, Record<string, unknown>>()
    for (const p of profiles) {
      if (
        p.identity &&
        typeof p.identity === 'object' &&
        Object.keys(p.identity as object).length > 0 &&
        !identityByKey.has(p.visitorKey)
      ) {
        identityByKey.set(p.visitorKey, p.identity as Record<string, unknown>)
      }
    }

    for (const [visitorKey, identity] of identityByKey) {
      await prisma.uploadVisitorIdentity.upsert({
        where: {
          uploadId_visitorKey: { uploadId: upload.id, visitorKey },
        },
        create: { uploadId: upload.id, visitorKey, identity },
        update: { identity },
      })
      inserted++
    }
  }

  return { uploads: uploads.length, identityRowsUpserted: inserted }
}

async function main() {
  const tableCheck = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'upload_visitor_identities'
  `

  if (tableCheck.length === 0) {
    console.log('Creating upload_visitor_identities table…')
    await prisma.$executeRaw`
      CREATE TABLE IF NOT EXISTS upload_visitor_identities (
        upload_id UUID NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
        visitor_key TEXT NOT NULL,
        identity JSONB NOT NULL,
        PRIMARY KEY (upload_id, visitor_key)
      )
    `
  } else {
    console.log('upload_visitor_identities table already exists')
  }

  const before = await prisma.uploadVisitorIdentity.count()
  console.log(`upload_visitor_identities rows before: ${before}`)

  const identityResult = await backfillUploadIdentities()
  console.log('Identity backfill:', identityResult)

  const coordsResult = await backfillProfileCoords()
  console.log('Profile coords backfill:', coordsResult)

  const after = await prisma.uploadVisitorIdentity.count()
  const withCoords = await prisma.visitorProfile.count({
    where: { lat: { not: null }, lng: { not: null } },
  })

  console.log(
    JSON.stringify(
      {
        uploadVisitorIdentityRowsAfter: after,
        visitorProfilesWithLatLng: withCoords,
      },
      null,
      2
    )
  )
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
