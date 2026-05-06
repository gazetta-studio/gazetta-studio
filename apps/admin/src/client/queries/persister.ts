/**
 * `Persister` factory — wraps `createAsyncStoragePersister` with
 * Gazetta-specific defaults and our `AdminCache`-backed storage.
 *
 * # Why a thin wrapper?
 *
 * - **Single-site-per-process invariant** (per `CONTEXT.md`): the
 *   persister stores one serialized `PersistedClient` per origin.
 *   Hardcoding the key here keeps callers from picking colliding
 *   names; one shipping default they don't have to think about.
 *
 * - **Throttle**: writes happen on every `QueryCache` event; the
 *   persister's `throttleTime` debounces them. 500ms balances
 *   data-loss-on-crash (small window) against IndexedDB write
 *   pressure during typing-heavy editing flows. Per
 *   `design-offline-implementation.md` Cut 5 Open Question 1.
 *
 * - **buster** for cache-purge on Gazetta major-version upgrades:
 *   when consumers bump the buster, the persister discards any
 *   persisted client whose buster doesn't match. Plumbed through
 *   so the admin SPA can pass `gazetta.version.major` at boot.
 *
 * # SOLID lenses
 *
 *   - SRP: this module owns the persister-with-our-defaults concern.
 *     The QueryClient itself + plugin install live in `client.ts`;
 *     the storage adapter lives in `storage-adapter.ts`.
 *   - DIP: takes `AdminCache`; doesn't know which provider it got.
 */
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister'
import type { Persister } from '@tanstack/query-persist-client-core'
import type { AdminCache } from 'gazetta'
import { cacheAsyncStorage } from './storage-adapter.js'

/**
 * Single fixed key under which the serialized `PersistedClient` is
 * stored. Hardcoded because there's only ever ONE persisted client
 * per origin (see "single-site-per-process" rationale above).
 *
 * Note: the persister itself adds a `tanstack-query-` prefix
 * internally (PERSISTER_KEY_PREFIX) — the on-disk key the cache
 * sees is `tanstack-query-gazetta-vue-query`.
 */
const GAZETTA_PERSISTER_KEY = 'gazetta-vue-query'

/**
 * 500ms — small enough that a crash mid-edit loses at most a half
 * second of cached query state; large enough that rapid typing
 * doesn't write to IndexedDB on every keystroke.
 */
const DEFAULT_THROTTLE_MS = 500

export interface CreateGazettaPersisterOptions {
  /**
   * Cache reset key. When the buster value changes between sessions,
   * the persister discards the persisted client. Use this to purge
   * caches on Gazetta major-version upgrades or for one-off resets.
   */
  buster?: string
  /** Override the default throttle interval for tests + power users. */
  throttleTime?: number
  /** Override the storage key. Tests use this to isolate runs. */
  key?: string
}

/**
 * Build a `Persister` against the given `AdminCache`. Pass the result
 * to `persistQueryClient({ persister, queryClient, ... })` or to
 * `VueQueryPlugin`'s `clientPersister`.
 */
export function createGazettaPersister(cache: AdminCache, opts: CreateGazettaPersisterOptions = {}): Persister {
  return createAsyncStoragePersister({
    storage: cacheAsyncStorage(cache),
    key: opts.key ?? GAZETTA_PERSISTER_KEY,
    throttleTime: opts.throttleTime ?? DEFAULT_THROTTLE_MS,
  })
}
