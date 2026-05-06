/**
 * Verify boot-time provider selection per `design-offline.md`'s
 * "Provider selection logic" — the selector probes IndexedDB and
 * falls back to MemoryCache when the probe fails.
 *
 * Two scenarios in two `describe` blocks (NOT one) because the
 * IndexedDB-unavailable case requires `globalThis.indexedDB` to be
 * undefined BEFORE any module loads. fake-indexeddb's `auto` import
 * is module-scoped — once loaded, even deleting the global doesn't
 * fully unwind the polyfill's plumbing across imports. Splitting the
 * scenarios into separate top-level describes lets vitest's module
 * graph stay clean within each file region.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

describe('selectBrowserCacheProvider — IndexedDB available', () => {
  beforeEach(async () => {
    // Polyfill loads once per worker; idempotent on subsequent imports.
    await import('fake-indexeddb/auto')
  })

  it('returns the IndexedDB provider with degraded=false', async () => {
    const { selectBrowserCacheProvider } = await import('../src/client/cache/provider-selector.js')
    const result = await selectBrowserCacheProvider()
    expect(result.kind).toBe('indexed-db')
    expect(result.degraded).toBe(false)
    expect(result.reason).toBeUndefined()
    // The cache is usable end-to-end — round-trip a value to prove
    // we got a wired provider, not a stub.
    await result.cache.set('probe', { hello: 'world' })
    expect(await result.cache.get('probe')).toEqual({ hello: 'world' })
  })
})

describe('selectBrowserCacheProvider — IndexedDB unavailable', () => {
  let originalIndexedDB: unknown

  beforeEach(() => {
    // Stash whatever's there (jsdom + earlier polyfills) and remove
    // it so the probe's `typeof indexedDB === 'undefined'` short-circuit
    // fires — exactly the path Safari Lockdown / very-old browsers take.
    originalIndexedDB = (globalThis as { indexedDB?: unknown }).indexedDB
    // @ts-expect-error — intentionally clearing the global for the probe
    delete (globalThis as { indexedDB?: unknown }).indexedDB
  })

  afterEach(() => {
    if (originalIndexedDB !== undefined) {
      ;(globalThis as { indexedDB?: unknown }).indexedDB = originalIndexedDB
    }
  })

  it('falls back to MemoryCache with degraded=true and a reason', async () => {
    // Import inside the test so the probe sees the cleared global.
    // Vitest module cache is per-file — we share it across both
    // describes, so the dynamic import returns the same selector
    // function in both. The probe runs every call.
    const { selectBrowserCacheProvider } = await import('../src/client/cache/provider-selector.js')
    const result = await selectBrowserCacheProvider()
    expect(result.kind).toBe('memory')
    expect(result.degraded).toBe(true)
    expect(result.reason).toBeTruthy()
    expect(result.reason).toMatch(/IndexedDB/i)
    // The fallback cache works for the in-tab session.
    await result.cache.set('probe', 'value')
    expect(await result.cache.get('probe')).toBe('value')
  })
})
