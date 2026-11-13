/**
 * The Cloudflare worker with the locale options the generated entry
 * embeds (#1138). Broader locale routing is in worker-cloudflare-r2.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createWorker } from '../src/workers/cloudflare-r2.js'

// ---------------------------------------------------------------------------
// Real worker with the options the generated entry embeds (#1138)
// ---------------------------------------------------------------------------

interface FakeBucket {
  bucket: { get(key: string): Promise<unknown> }
}

function fakeBucket(seed: Record<string, string>): FakeBucket {
  const files = new Map(Object.entries(seed))
  return {
    bucket: {
      async get(key) {
        const value = files.get(key)
        if (value === undefined) return null
        return {
          async text() {
            return value
          },
        }
      },
    },
  }
}

describe('createWorker with embedded site locales', () => {
  const originalCaches = (globalThis as { caches?: unknown }).caches

  beforeEach(() => {
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      writable: true,
      value: { default: { match: async () => undefined, put: async () => {} } },
    })
  })

  afterEach(() => {
    if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches)
    else delete (globalThis as { caches?: unknown }).caches
  })

  it('serves a non-default language page', async () => {
    const { bucket } = fakeBucket({
      'pages/home/index.html': '<!DOCTYPE html><html><body>Home</body></html>',
      'pages/about/index.html': '<!DOCTYPE html><html><body>About</body></html>',
      'pages/about/index.fr.html': '<!DOCTYPE html><html><body>\u00c0 propos</body></html>',
    })
    const app = createWorker({ locales: ['en', 'fr'], defaultLocale: 'en', defaultPrefix: false })

    const res = await app.fetch(
      new Request('https://example.com/fr/about'),
      { SITE_BUCKET: bucket } as never,
      { waitUntil: () => {}, passThroughOnException: () => {} } as never,
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('\u00c0 propos')
  })
})
