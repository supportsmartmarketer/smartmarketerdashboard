import { prisma } from './prisma'

export interface GeoLocation {
  city?: string
  region?: string
  country?: string
  lat?: number
  lng?: number
}

/**
 * Parse coordinates from CSV field
 * Accepts: {"lat": 40.7128, "lng": -74.0060} or "40.7128,-74.0060" or null
 */
export function parseCoordinates(coords: any): { lat: number; lng: number } | null {
  if (!coords) return null

  // If it's already an object with lat/lng
  if (typeof coords === 'object' && coords.lat && coords.lng) {
    return { lat: parseFloat(coords.lat), lng: parseFloat(coords.lng) }
  }

  // If it's a string like "lat,lng"
  if (typeof coords === 'string') {
    const parts = coords.split(',')
    if (parts.length === 2) {
      const lat = parseFloat(parts[0].trim())
      const lng = parseFloat(parts[1].trim())
      if (!isNaN(lat) && !isNaN(lng)) {
        return { lat, lng }
      }
    }
  }

  return null
}

/**
 * Get geo location from cache or provider
 */
export async function getGeoLocation(ip: string | null | undefined): Promise<GeoLocation | null> {
  if (!ip || ip === '') return null

  // Check cache first
  const cached = await prisma.geoCache.findUnique({
    where: { ip },
  })

  if (cached && cached.lat && cached.lng) {
    return {
      city: cached.city || undefined,
      region: cached.region || undefined,
      country: cached.country || undefined,
      lat: cached.lat,
      lng: cached.lng,
    }
  }

  // Fetch from provider
  const provider = process.env.GEO_PROVIDER || 'ipinfo'
  const apiKey = process.env.GEO_API_KEY

  try {
    let geoData: GeoLocation | null = null

    if (provider === 'ipinfo') {
      geoData = await fetchFromIpInfo(ip, apiKey)
    } else if (provider === 'ipapi') {
      geoData = await fetchFromIpApi(ip, apiKey)
    }

    if (geoData && geoData.lat && geoData.lng) {
      // Cache the result
      await prisma.geoCache.upsert({
        where: { ip },
        update: {
          city: geoData.city || null,
          region: geoData.region || null,
          country: geoData.country || null,
          lat: geoData.lat || null,
          lng: geoData.lng || null,
          updatedAt: new Date(),
        },
        create: {
          ip,
          city: geoData.city || null,
          region: geoData.region || null,
          country: geoData.country || null,
          lat: geoData.lat || null,
          lng: geoData.lng || null,
        },
      })
    }

    return geoData
  } catch (error) {
    console.error(`Error fetching geo for IP ${ip}:`, error)
    return null
  }
}

async function fetchFromIpInfo(ip: string, apiKey?: string): Promise<GeoLocation | null> {
  try {
    const url = apiKey
      ? `https://ipinfo.io/${ip}?token=${apiKey}`
      : `https://ipinfo.io/${ip}/json`
    const response = await fetch(url)
    const data = await response.json()

    if (data.loc) {
      const [lat, lng] = data.loc.split(',').map(parseFloat)
      return {
        city: data.city,
        region: data.region,
        country: data.country,
        lat,
        lng,
      }
    }
    return null
  } catch (error) {
    console.error('Error fetching from ipinfo:', error)
    return null
  }
}

async function fetchFromIpApi(ip: string, apiKey?: string): Promise<GeoLocation | null> {
  try {
    const url = apiKey
      ? `https://ipapi.co/${ip}/json/?key=${apiKey}`
      : `https://ipapi.co/${ip}/json/`
    const response = await fetch(url)
    const data = await response.json()

    if (data.latitude && data.longitude) {
      return {
        city: data.city,
        region: data.region,
        country: data.country_name,
        lat: data.latitude,
        lng: data.longitude,
      }
    }
    return null
  } catch (error) {
    console.error('Error fetching from ipapi:', error)
    return null
  }
}

// Rate limiting for geocoding (Nominatim public API: ~1 request per second for bulk use)
let lastGeocodeTime = 0
const GEOCODE_RATE_LIMIT_MS = 1100

function nominatimUserAgent(): string {
  const fromEnv = process.env.NOMINATIM_USER_AGENT?.trim()
  if (fromEnv) return fromEnv
  // Nominatim policy: identifiable application + contact; generic UAs often get HTTP 403 from cloud hosts.
  return 'SmartMarketerDashboard/1.0 (https://github.com/arsalanrs/smartmarketerdashboard — set NOMINATIM_USER_AGENT with your contact email)'
}

/**
 * Geocode address to coordinates using OpenStreetMap Nominatim (free, no API key needed)
 */
export async function geocodeAddress(
  address: string,
  city?: string,
  state?: string,
  zip?: string,
  country?: string
): Promise<GeoLocation | null> {
  try {
    // Build address string
    const addressParts: string[] = []
    if (address) addressParts.push(address)
    if (city) addressParts.push(city)
    if (state) addressParts.push(state)
    if (zip) addressParts.push(zip)
    if (country) addressParts.push(country)

    if (addressParts.length === 0) {
      return null
    }

    const addressString = addressParts.join(', ')
    
    // Rate limiting: wait if needed (1 request per second)
    const now = Date.now()
    const timeSinceLastRequest = now - lastGeocodeTime
    if (timeSinceLastRequest < GEOCODE_RATE_LIMIT_MS) {
      await new Promise(resolve => setTimeout(resolve, GEOCODE_RATE_LIMIT_MS - timeSinceLastRequest))
    }
    lastGeocodeTime = Date.now()
    
    // OpenStreetMap Nominatim — https://operations.osmfoundation.org/policies/nominatim/
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(addressString)}&limit=1`

    const response = await fetch(url, {
      headers: {
        'User-Agent': nominatimUserAgent(),
        Accept: 'application/json',
        'Accept-Language': 'en',
      },
    })

    if (!response.ok) {
      const hint =
        response.status === 403
          ? ' — Nominatim often returns 403 for cloud IPs or missing contact in User-Agent; set env NOMINATIM_USER_AGENT=MyApp/1.0 (you@company.com) or use a paid geocoder'
          : response.status === 429
            ? ' — rate limited; add delay between requests or use a paid geocoder'
            : ''
      console.warn(`Geocoding failed for address: ${addressString} (HTTP ${response.status})${hint}`)
      return null
    }

    const data = await response.json()

    if (Array.isArray(data) && data.length > 0) {
      const result = data[0]
      return {
        city: result.address?.city || result.address?.town || city || undefined,
        region: result.address?.state || state || undefined,
        country: result.address?.country || country || undefined,
        lat: parseFloat(result.lat),
        lng: parseFloat(result.lon),
      }
    }

    return null
  } catch (error) {
    console.error(`Error geocoding address "${address}":`, error)
    return null
  }
}

