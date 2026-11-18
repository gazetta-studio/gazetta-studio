/**
 * Cloudflare zone lookup for the CDN purge (#1187): the siteUrl
 * hostname may be a subdomain of the zone, so the lookup asks for the
 * hostname, then each parent, until a zone answers. An explicit
 * `purge.zoneId` skips the API.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { lookupCloudflareZoneId, resolveCloudflareZoneId } from '../src/publish-rendered.js'

const ZONES: Record<string, string> = { 'mysite.com': 'zone-mysite' }

function stubZonesApi() {
  const fetchMock = vi.fn(async (input: string | URL) => {
    const name = new URL(String(input)).searchParams.get('name') ?? ''
    const id = ZONES[name]
    return new Response(JSON.stringify({ result: id ? [{ id }] : [] }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('lookupCloudflareZoneId()', () => {
  it('walks up from a subdomain to its parent zone', async () => {
    const fetchMock = stubZonesApi()
    expect(await lookupCloudflareZoneId('https://blog.mysite.com', 'token')).toBe('zone-mysite')
    const asked = fetchMock.mock.calls.map(([u]) => new URL(String(u)).searchParams.get('name'))
    expect(asked).toEqual(['blog.mysite.com', 'mysite.com'])
  })

  it('finds an apex zone with one request', async () => {
    const fetchMock = stubZonesApi()
    expect(await lookupCloudflareZoneId('https://mysite.com', 'token')).toBe('zone-mysite')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns null without asking for the bare TLD when no zone matches', async () => {
    const fetchMock = stubZonesApi()
    expect(await lookupCloudflareZoneId('https://a.other.org', 'token')).toBeNull()
    const asked = fetchMock.mock.calls.map(([u]) => new URL(String(u)).searchParams.get('name'))
    expect(asked).toEqual(['a.other.org', 'other.org'])
  })
})

describe('resolveCloudflareZoneId()', () => {
  it('uses an explicit zoneId without calling the API', async () => {
    const fetchMock = stubZonesApi()
    expect(await resolveCloudflareZoneId('explicit-zone', 'https://blog.mysite.com', 'token')).toBe('explicit-zone')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('looks the zone up from siteUrl when no zoneId is set', async () => {
    stubZonesApi()
    expect(await resolveCloudflareZoneId(undefined, 'https://blog.mysite.com', 'token')).toBe('zone-mysite')
  })
})
