import type { GeoLocation } from './geo'

/** US state / territory centroids for map fallback when external geocoders fail. */
const US_STATE_CENTROIDS: Record<string, { lat: number; lng: number; name: string }> = {
  AL: { lat: 32.806671, lng: -86.79113, name: 'Alabama' },
  AK: { lat: 61.370716, lng: -152.404419, name: 'Alaska' },
  AZ: { lat: 33.729759, lng: -111.431221, name: 'Arizona' },
  AR: { lat: 34.969704, lng: -92.373123, name: 'Arkansas' },
  CA: { lat: 36.116203, lng: -119.681564, name: 'California' },
  CO: { lat: 39.059811, lng: -105.311104, name: 'Colorado' },
  CT: { lat: 41.597782, lng: -72.755371, name: 'Connecticut' },
  DE: { lat: 39.318523, lng: -75.507141, name: 'Delaware' },
  DC: { lat: 38.897438, lng: -77.026817, name: 'District of Columbia' },
  FL: { lat: 27.766279, lng: -81.686783, name: 'Florida' },
  GA: { lat: 33.040619, lng: -83.643074, name: 'Georgia' },
  HI: { lat: 21.094318, lng: -157.498337, name: 'Hawaii' },
  ID: { lat: 44.240459, lng: -114.478828, name: 'Idaho' },
  IL: { lat: 40.349457, lng: -88.986137, name: 'Illinois' },
  IN: { lat: 39.849426, lng: -86.258278, name: 'Indiana' },
  IA: { lat: 42.011539, lng: -93.210526, name: 'Iowa' },
  KS: { lat: 38.5266, lng: -96.726486, name: 'Kansas' },
  KY: { lat: 37.66814, lng: -84.670067, name: 'Kentucky' },
  LA: { lat: 31.169546, lng: -91.867805, name: 'Louisiana' },
  ME: { lat: 44.693947, lng: -69.381927, name: 'Maine' },
  MD: { lat: 39.063946, lng: -76.802101, name: 'Maryland' },
  MA: { lat: 42.230171, lng: -71.530106, name: 'Massachusetts' },
  MI: { lat: 43.326618, lng: -84.536095, name: 'Michigan' },
  MN: { lat: 45.694454, lng: -93.900192, name: 'Minnesota' },
  MS: { lat: 32.741646, lng: -89.678696, name: 'Mississippi' },
  MO: { lat: 38.456085, lng: -92.288368, name: 'Missouri' },
  MT: { lat: 46.921925, lng: -110.454353, name: 'Montana' },
  NE: { lat: 41.12537, lng: -98.268082, name: 'Nebraska' },
  NV: { lat: 38.313515, lng: -117.055374, name: 'Nevada' },
  NH: { lat: 43.452492, lng: -71.563896, name: 'New Hampshire' },
  NJ: { lat: 40.298904, lng: -74.521011, name: 'New Jersey' },
  NM: { lat: 34.840515, lng: -106.248482, name: 'New Mexico' },
  NY: { lat: 42.165726, lng: -74.948051, name: 'New York' },
  NC: { lat: 35.630066, lng: -79.806419, name: 'North Carolina' },
  ND: { lat: 47.528912, lng: -99.784012, name: 'North Dakota' },
  OH: { lat: 40.388783, lng: -82.764915, name: 'Ohio' },
  OK: { lat: 35.565342, lng: -96.928917, name: 'Oklahoma' },
  OR: { lat: 44.572021, lng: -122.070938, name: 'Oregon' },
  PA: { lat: 40.590752, lng: -77.209755, name: 'Pennsylvania' },
  RI: { lat: 41.680893, lng: -71.51178, name: 'Rhode Island' },
  SC: { lat: 33.856892, lng: -80.945007, name: 'South Carolina' },
  SD: { lat: 44.299782, lng: -99.438828, name: 'South Dakota' },
  TN: { lat: 35.747845, lng: -86.692345, name: 'Tennessee' },
  TX: { lat: 31.054487, lng: -97.563461, name: 'Texas' },
  UT: { lat: 40.150032, lng: -111.862434, name: 'Utah' },
  VT: { lat: 44.045876, lng: -72.710686, name: 'Vermont' },
  VA: { lat: 37.769337, lng: -78.169968, name: 'Virginia' },
  WA: { lat: 47.400902, lng: -121.490494, name: 'Washington' },
  WV: { lat: 38.491226, lng: -80.954453, name: 'West Virginia' },
  WI: { lat: 44.268543, lng: -89.616508, name: 'Wisconsin' },
  WY: { lat: 42.755966, lng: -107.30249, name: 'Wyoming' },
}

function normalizeStateKey(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null
  const s = raw.trim()
  if (s.length === 2) return s.toUpperCase()
  const upper = s.toUpperCase()
  for (const [abbr, info] of Object.entries(US_STATE_CENTROIDS)) {
    if (info.name.toUpperCase() === upper) return abbr
  }
  return null
}

/** Spread markers that share a state so they don't stack on one dot. */
export function jitterCoords(
  lat: number,
  lng: number,
  seed: string
): { lat: number; lng: number } {
  let h = 0
  for (let i = 0; i < seed.length; i++) {
    h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0
  }
  const r1 = ((h >>> 0) % 1000) / 1000 - 0.5
  const r2 = (((h / 1000) >>> 0) % 1000) / 1000 - 0.5
  return { lat: lat + r1 * 0.65, lng: lng + r2 * 0.95 }
}

/**
 * Approximate map coordinates from city/state/country without external APIs.
 * Prefer state centroid; optional jitter per visitorKey.
 */
export function approximateGeoFromPlace(
  city: string | null | undefined,
  state: string | null | undefined,
  country: string | null | undefined,
  jitterSeed?: string
): GeoLocation | null {
  const stateKey = normalizeStateKey(state)
  if (!stateKey) return null

  const countryNorm = (country || 'US').trim().toUpperCase()
  if (countryNorm && countryNorm !== 'US' && countryNorm !== 'USA' && countryNorm !== 'UNITED STATES') {
    return null
  }

  const centroid = US_STATE_CENTROIDS[stateKey]
  if (!centroid) return null

  const coords = jitterSeed
    ? jitterCoords(centroid.lat, centroid.lng, jitterSeed)
    : { lat: centroid.lat, lng: centroid.lng }

  return {
    lat: coords.lat,
    lng: coords.lng,
    city: city?.trim() || undefined,
    region: state?.trim() || centroid.name,
    country: 'US',
  }
}

function readIdentityField(identity: unknown, ...keys: string[]): string | undefined {
  if (!identity || typeof identity !== 'object') return undefined
  const o = identity as Record<string, unknown>
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return undefined
}

/** Parse "City, ST 12345, US" style strings from company/personal address columns. */
export function parsePlaceFromAddress(raw: string | null | undefined): {
  city?: string
  state?: string
} {
  if (!raw?.trim()) return {}
  const parts = raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length < 2) return {}

  let statePart = parts[parts.length - 1]
  let cityPart = parts[parts.length - 2]

  if (/^(us|usa|united states)$/i.test(statePart) && parts.length >= 3) {
    statePart = parts[parts.length - 2]
    cityPart = parts[parts.length - 3]
  }

  const stateToken =
    statePart.match(/^([A-Za-z]{2})\b/)?.[1] ||
    statePart.replace(/\d.*$/, '').trim()

  return {
    city: cityPart || undefined,
    state: stateToken || undefined,
  }
}

function pickPlaceFields(
  city: string | null | undefined,
  region: string | null | undefined,
  identity: unknown
): { city: string | null; region: string | null; country: string } {
  let resolvedCity = city?.trim() || null
  let resolvedRegion = region?.trim() || null

  if (identity && typeof identity === 'object') {
    resolvedCity =
      resolvedCity ||
      readIdentityField(identity, 'city', 'personal_city', 'company_city') ||
      null
    resolvedRegion =
      resolvedRegion ||
      readIdentityField(identity, 'state', 'personal_state', 'company_state') ||
      null

    if (!resolvedCity || !resolvedRegion) {
      const address =
        readIdentityField(
          identity,
          'address',
          'companyAddress',
          'company_address',
          'personal_address'
        ) || ''
      const parsed = parsePlaceFromAddress(address)
      resolvedCity = resolvedCity || parsed.city || null
      resolvedRegion = resolvedRegion || parsed.state || null
    }
  }

  const country =
    readIdentityField(identity, 'country', 'personal_country', 'company_country') || 'US'

  return { city: resolvedCity, region: resolvedRegion, country }
}

export type ResolvedMapLocation = {
  lat: number
  lng: number
  city: string | null
  region: string | null
  approximate: boolean
}

/** Resolve lat/lng for map display from profile fields + identity fallback. */
export function resolveProfileMapLocation(profile: {
  visitorKey: string
  lat: number | null
  lng: number | null
  city: string | null
  region: string | null
  country: string | null
  identity: unknown
}): ResolvedMapLocation | null {
  if (
    typeof profile.lat === 'number' &&
    typeof profile.lng === 'number' &&
    Number.isFinite(profile.lat) &&
    Number.isFinite(profile.lng)
  ) {
    return {
      lat: profile.lat,
      lng: profile.lng,
      city: profile.city,
      region: profile.region,
      approximate: false,
    }
  }

  const { city, region, country } = pickPlaceFields(
    profile.city,
    profile.region,
    profile.identity
  )

  const approx = approximateGeoFromPlace(city, region, country, profile.visitorKey)
  if (!approx?.lat || !approx?.lng) return null

  return {
    lat: approx.lat,
    lng: approx.lng,
    city: city || approx.city || null,
    region: region || approx.region || null,
    approximate: true,
  }
}
