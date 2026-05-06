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

describe('selectBrowserCacheProvider — IndexedDB defined but transactions throw (Safari Lockdown)', () => {
  // The design-offline.md "Provider selection logic" specifically
  // calls out: "Some browsers (notably Safari private mode) report
  // IndexedDB available but throw on actual use." The probe opens
  // a real database AND runs a smoke transaction precisely so this
  // browser shape gets caught and falls back to MemoryCache rather
  // than being trusted with persistence the browser will actively
  // sabotage.

  let originalIndexedDB: unknown
  function stubIndexedDB(impl: Partial<IDBFactory>): void {
    originalIndexedDB = (globalThis as { indexedDB?: unknown }).indexedDB
    Object.defineProperty(globalThis, 'indexedDB', {
      value: impl,
      configurable: true,
      writable: true,
    })
  }

  afterEach(() => {
    if (originalIndexedDB === undefined) {
      // @ts-expect-error: deleting stubbed property
      delete (globalThis as { indexedDB?: unknown }).indexedDB
    } else {
      Object.defineProperty(globalThis, 'indexedDB', {
        value: originalIndexedDB,
        configurable: true,
        writable: true,
      })
    }
  })

  it('falls back to MemoryCache when indexedDB.open() throws synchronously', async () => {
    stubIndexedDB({
      open: () => {
        throw new Error('IDBFactory.open is disabled in this context')
      },
    } as Partial<IDBFactory>)

    const { selectBrowserCacheProvider } = await import('../src/client/cache/provider-selector.js')
    const result = await selectBrowserCacheProvider()
    expect(result.kind).toBe('memory')
    expect(result.degraded).toBe(true)
    expect(result.reason).toBeTruthy()
    // Fallback cache is fully usable.
    await result.cache.set('probe', 'value')
    expect(await result.cache.get('probe')).toBe('value')
  })

  it('falls back to MemoryCache when indexedDB.open() rejects via onerror', async () => {
    // Asynchronous failure shape — older Safari + private contexts
    // accept open() but the request emits onerror. The probe wraps
    // open() in a Promise; onerror rejects the wrapper.
    stubIndexedDB({
      open: () => {
        const req = {
          onsuccess: null as null | (() => void),
          onerror: null as null | (() => void),
          onupgradeneeded: null as null | (() => void),
          onblocked: null as null | (() => void),
          error: new Error('open() forbidden'),
          result: null as unknown,
        }
        // Fire onerror on the next microtask — after the probe
        // attaches its handler.
        Promise.resolve().then(() => req.onerror?.())
        return req as unknown as IDBOpenDBRequest
      },
    } as Partial<IDBFactory>)

    const { selectBrowserCacheProvider } = await import('../src/client/cache/provider-selector.js')
    const result = await selectBrowserCacheProvider()
    expect(result.kind).toBe('memory')
    expect(result.degraded).toBe(true)
    expect(result.reason).toMatch(/forbidden/i)
  })

  it('falls back to MemoryCache when the smoke transaction throws after open() succeeds', async () => {
    // The Safari Lockdown / private-browsing case the design-offline.md
    // probe was specifically built to catch: open() reports success,
    // but the first transaction throws.
    stubIndexedDB({
      open: () => {
        const fakeDb = {
          transaction: () => {
            throw new Error('Transactions disabled in private mode')
          },
          close: () => {},
          createObjectStore: () => ({}),
        }
        const req = {
          onsuccess: null as null | (() => void),
          onerror: null as null | (() => void),
          onupgradeneeded: null as null | (() => void),
          onblocked: null as null | (() => void),
          error: null,
          result: fakeDb,
        }
        Promise.resolve().then(() => {
          // upgradeneeded fires first (DB version 1 from nothing); then
          // success, both before any test-side promise tick completes.
          req.onupgradeneeded?.()
          req.onsuccess?.()
        })
        return req as unknown as IDBOpenDBRequest
      },
      deleteDatabase: () => {
        const req = {
          onsuccess: null as null | (() => void),
          onerror: null as null | (() => void),
          error: null,
        }
        Promise.resolve().then(() => req.onsuccess?.())
        return req as unknown as IDBOpenDBRequest
      },
    } as Partial<IDBFactory>)

    const { selectBrowserCacheProvider } = await import('../src/client/cache/provider-selector.js')
    const result = await selectBrowserCacheProvider()
    expect(result.kind).toBe('memory')
    expect(result.degraded).toBe(true)
    // Reason carries the throw's message, not the API-undefined fallback.
    expect(result.reason).toMatch(/transaction|disabled|private/i)
  })
})
