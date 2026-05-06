/**
 * Verify the client's save-etag plumbing per `design-offline.md` Q3.
 *
 * The server-side contract (ETag header on GET, If-Match on PUT,
 * 409 STALE response shape) is exercised by gazetta's admin-api
 * tests. THIS file pins the client-side translation layer:
 *
 *   - `getPageWithEtag` / `getFragmentWithEtag` parse the server's
 *     `ETag` header (RFC-7232 quoted) and expose the unquoted value
 *   - `updatePage` / `updateFragment` send `If-Match` (re-quoted)
 *     when the caller passes `ifMatch`
 *   - 409 STALE responses surface as `StaleSaveError` carrying the
 *     server's `current` manifest body and `currentEtag`
 *
 * Uses `vi.spyOn(global, 'fetch')` to mock the server response so
 * tests run without a real admin process.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, setActiveTargetProvider, StaleSaveError, ValidationFailedError } from '../src/client/api/client.js'

afterEach(() => {
  vi.restoreAllMocks()
  setActiveTargetProvider(null)
})

function mockFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Response): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => handler(input, init))
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) },
  })
}

describe('getPageWithEtag', () => {
  it('returns parsed body + unquoted etag from response header', async () => {
    mockFetch(() =>
      jsonResponse(
        { name: 'home', route: '/', template: 'page-default', content: {}, components: [], dir: 'pages/home' },
        { headers: { ETag: '"abc1234567890def"' } },
      ),
    )
    const result = await api.getPageWithEtag('home')
    expect(result.data.name).toBe('home')
    // Quotes stripped — caller stores the raw 16-hex.
    expect(result.etag).toBe('abc1234567890def')
  })

  it('returns null etag when server omits the header (e.g., legacy server)', async () => {
    mockFetch(() =>
      jsonResponse({
        name: 'home',
        route: '/',
        template: 'page-default',
        content: {},
        components: [],
        dir: 'pages/home',
      }),
    )
    const result = await api.getPageWithEtag('home')
    expect(result.etag).toBeNull()
  })

  it('threads the locale option through the URL', async () => {
    let capturedUrl = ''
    mockFetch(input => {
      capturedUrl = input.toString()
      return jsonResponse(
        { name: 'home', route: '/', template: 'page-default', content: {}, components: [], dir: 'pages/home' },
        { headers: { ETag: '"x"' } },
      )
    })
    await api.getPageWithEtag('home', { locale: 'fr' })
    expect(capturedUrl).toContain('locale=fr')
  })
})

describe('getFragmentWithEtag', () => {
  it('returns parsed body + unquoted etag', async () => {
    mockFetch(() =>
      jsonResponse(
        { name: 'header', template: 'header-layout', content: {}, components: [], dir: 'fragments/header' },
        { headers: { ETag: '"deadbeef12345678"' } },
      ),
    )
    const result = await api.getFragmentWithEtag('header')
    expect(result.data.name).toBe('header')
    expect(result.etag).toBe('deadbeef12345678')
  })
})

describe('updatePage with ifMatch', () => {
  it('re-quotes the ifMatch value into the If-Match header', async () => {
    let capturedHeaders: Record<string, string> = {}
    mockFetch((_, init) => {
      capturedHeaders = (init?.headers as Record<string, string>) ?? {}
      return jsonResponse({ ok: true, etag: 'new1234567890ab' })
    })
    await api.updatePage('home', { content: { title: 'New' } }, { ifMatch: 'old1234567890ab' })
    expect(capturedHeaders['If-Match']).toBe('"old1234567890ab"')
  })

  it('omits If-Match header when ifMatch is not supplied', async () => {
    let capturedHeaders: Record<string, string> = {}
    mockFetch((_, init) => {
      capturedHeaders = (init?.headers as Record<string, string>) ?? {}
      return jsonResponse({ ok: true })
    })
    await api.updatePage('home', { content: { title: 'New' } })
    expect(capturedHeaders['If-Match']).toBeUndefined()
  })

  it('returns the server-echoed etag for chain projection', async () => {
    mockFetch(() => jsonResponse({ ok: true, etag: 'projected-etag-x' }))
    const result = await api.updatePage('home', { content: { title: 'A' } }, { ifMatch: 'baseline' })
    expect(result.etag).toBe('projected-etag-x')
  })

  it('throws StaleSaveError on 409 STALE with server current manifest', async () => {
    mockFetch(() =>
      jsonResponse(
        {
          code: 'STALE',
          current: { template: 'page-default', content: { title: 'Drift' }, components: [] },
          currentEtag: 'fresher-etag-x',
        },
        { status: 409 },
      ),
    )
    await expect(api.updatePage('home', { content: { title: 'Mine' } }, { ifMatch: 'stale' })).rejects.toThrow(
      StaleSaveError,
    )
  })

  it('StaleSaveError carries the server `current` manifest + currentEtag', async () => {
    mockFetch(() =>
      jsonResponse(
        {
          code: 'STALE',
          current: { template: 'page-default', content: { title: 'Drift' }, components: ['a', 'b'] },
          currentEtag: 'server-fresh-etag',
        },
        { status: 409 },
      ),
    )
    try {
      await api.updatePage('home', { content: { title: 'Mine' } }, { ifMatch: 'stale' })
      expect.fail('expected StaleSaveError')
    } catch (err) {
      expect(err).toBeInstanceOf(StaleSaveError)
      const stale = err as StaleSaveError
      expect(stale.code).toBe('STALE')
      expect((stale.current.content as { title: string }).title).toBe('Drift')
      expect(stale.currentEtag).toBe('server-fresh-etag')
    }
  })

  it('still throws ValidationFailedError on 409 VALIDATION_FAILED (no regression)', async () => {
    mockFetch(() =>
      jsonResponse(
        {
          code: 'VALIDATION_FAILED',
          issues: [
            {
              validator: 'referenced-asset-exists',
              severity: 'error',
              message: 'missing',
              itemPath: 'pages/home/page.json',
            },
          ],
        },
        { status: 409 },
      ),
    )
    await expect(api.updatePage('home', { content: {} })).rejects.toThrow(ValidationFailedError)
  })
})

describe('updateFragment with ifMatch', () => {
  it('sends If-Match for fragments and surfaces 409 STALE the same way', async () => {
    let capturedHeaders: Record<string, string> = {}
    mockFetch((_, init) => {
      capturedHeaders = (init?.headers as Record<string, string>) ?? {}
      return jsonResponse(
        { code: 'STALE', current: { template: 'header-layout', content: {}, components: [] }, currentEtag: 'fresh' },
        { status: 409 },
      )
    })
    await expect(api.updateFragment('header', { content: {} }, { ifMatch: 'stale' })).rejects.toThrow(StaleSaveError)
    expect(capturedHeaders['If-Match']).toBe('"stale"')
  })
})
