/**
 * Boot-time browser cache provider selection per `design-offline.md`
 * "Provider selection logic":
 *
 *   if (await indexedDBProbe()) return IndexedDBCache
 *   else                       return MemoryCache + warning
 *
 * Some browsers (notably Safari private mode) report IndexedDB
 * available but throw on actual use. The probe opens a real database
 * + does a smoke transaction; only providers that pass the probe are
 * trusted to persist.
 *
 * # SOLID lenses
 *
 *   - SRP: this module owns "pick the right browser cache provider."
 *     Provider implementations are siblings; UX banner is rendered
 *     by Vue components reading the `degraded` flag on the result.
 *   - DIP: callers depend on `AdminCache` and the result envelope;
 *     they don't know which provider they got.
 *   - OCP: future providers (LocalStorageCache, OPFSCache) slot in
 *     by extending the probe-and-pick chain; existing branches
 *     unchanged.
 */
import type { AdminCache } from 'gazetta'
import { createIndexedDBCache } from './indexeddb-cache.js'
import { createBrowserMemoryCache } from './memory-cache.js'

export interface SelectedProvider {
  /** The chosen `AdminCache` instance — ready to use. */
  cache: AdminCache
  /**
   * Identifier of the chosen provider for diagnostics + UX. Operators
   * see this on the cache stats endpoint; the offline UX banner
   * branches on `degraded` to decide whether to warn the user.
   */
  kind: 'indexed-db' | 'memory'
  /**
   * True when persistence is unavailable (IndexedDB probe failed).
   * Vue layer renders a one-time banner: "Offline persistence
   * unavailable — your edits will be lost on reload." Per
   * `design-offline.md` Q1 lock.
   */
  degraded: boolean
  /**
   * When `degraded`, the reason the probe failed. Logged for
   * operator diagnosis; not surfaced to authors.
   */
  reason?: string
}

const PROBE_DB_NAME = '__gazetta_probe__'

/**
 * Probe IndexedDB by opening a tiny database and performing a
 * read-write smoke transaction. This catches:
 *   - IndexedDB undefined entirely (very old browsers)
 *   - `indexedDB.open()` throws (some embedded contexts)
 *   - `open()` succeeds but transactions throw (Safari private mode
 *     in older Safari builds)
 *
 * The probe DB is closed and deleted after the smoke test so it
 * doesn't leak into the user's storage budget. Failures during
 * cleanup are swallowed — the probe's verdict is what matters.
 */
async function indexedDBProbe(): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (typeof indexedDB === 'undefined') {
    return { ok: false, reason: 'IndexedDB API is not defined in this browser' }
  }
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(PROBE_DB_NAME, 1)
      req.onupgradeneeded = () => req.result.createObjectStore('probe')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('open() failed'))
      req.onblocked = () => reject(new Error('open() blocked'))
    })

    // Smoke transaction — write + read + delete. Some private-mode
    // browsers fail here even when open() succeeded.
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('probe', 'readwrite')
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error ?? new Error('transaction failed'))
        tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'))
        const store = tx.objectStore('probe')
        store.put('ok', 'probe-key')
      })
    } finally {
      db.close()
    }

    // Best-effort cleanup. If this fails, the probe DB stays around
    // — small, but un-tidy. Not worth surfacing to callers.
    try {
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.deleteDatabase(PROBE_DB_NAME)
        req.onsuccess = () => resolve()
        req.onerror = () => reject(req.error ?? new Error('deleteDatabase failed'))
      })
    } catch {
      // ignore
    }

    return { ok: true }
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }
}

/**
 * Pick the browser cache provider for this admin session. Call once
 * at admin boot; cache the result for the session. Returns the
 * chosen provider plus a `degraded` flag the UX layer reads to
 * surface the persistence-unavailable banner.
 */
export async function selectBrowserCacheProvider(): Promise<SelectedProvider> {
  const probe = await indexedDBProbe()
  if (probe.ok) {
    return {
      cache: await createIndexedDBCache(),
      kind: 'indexed-db',
      degraded: false,
    }
  }
  return {
    cache: createBrowserMemoryCache(),
    kind: 'memory',
    degraded: true,
    reason: probe.reason,
  }
}
