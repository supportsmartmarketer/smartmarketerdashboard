import { NextRequest } from 'next/server'

/** Vercel Cron sends Authorization: Bearer CRON_SECRET when CRON_SECRET is set. */
export function verifyCronRequest(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim()
  if (!secret) {
    return process.env.NODE_ENV !== 'production'
  }
  const auth = request.headers.get('authorization')
  if (auth === `Bearer ${secret}`) return true
  return request.headers.get('x-cron-secret') === secret
}
