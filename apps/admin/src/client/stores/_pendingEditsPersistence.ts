/**
 * Pending-edits persistence — bridges the in-memory pending-edits
 * Pinia stores to the L6 `AdminCache` so edits survive browser
 * reload per `design-offline.md`'s "Pending edits persist across
 * browser reload" invariant.
 *
 * # Cut 8 scope (this module)
 *
 * Persists `editorStructural` only. Structural edits (component
 * reorder / add / remove on a manifest) are pure data — no closures,
 * no transient mounts. Reorders are also higher-friction for an
 * author to redo than re-typing a field, so they're the highest-
 * value persistence target for this cut.
 *
 * `editorStash` + `editorContent` persistence is **deferred to Cut
 * 8b**. Both stores carry an `EditingTarget` with a `save` closure
 * bound to the page's selection state. Persisting them naively
 * loses the closure; rehydration needs to rebuild it via the
 * navigate flow — a non-trivial seam that deserves its own focused
 * cut rather than being rushed alongside the structural pass.
 *
 * # SOLID lenses
 *
 *   - SRP: this module owns the persistence-coordinator concern.
 *     Stores stay store-shaped (state + mutations); the coordinator
 *     observes + serializes + hydrates externally.
 *   - DIP: takes any `AdminCache`. The selector picks IndexedDB or
 *     memory; this coordinator doesn't care which.
 *   - OCP: future per-store sub-modules (stash, content) plug in
 *     through additional `attach...()` calls without changing what's
 *     here.
 *
 * # Cache key conventions
 *
 * Per `design-cache.md` Q1, reserved prefix is `pending-edits:`.
 * One key per persisted store: `pending-edits:structural`. Future
 * cuts add `pending-edits:stash` + `pending-edits:content`.
 */
import { watch } from 'vue'
import type { AdminCache } from 'gazetta'
import type { ComponentEntry, ManifestKey } from 'gazetta/types'
import { manifestKeyFromString } from 'gazetta/types'
import { useEditorStructuralStore, type StructuralEntry } from './editorStructural.js'

/**
 * Cache key for `editorStructural` snapshots. v1 stores everything
 * under one key; if structural state ever grows large enough to
 * warrant per-manifest-key sharding, that's a forward change.
 */
const STRUCTURAL_KEY = 'pending-edits:structural'

/**
 * Debounce window between mutation and write. Keeps IndexedDB write
 * pressure low during rapid drag-reorders without losing more than a
 * fraction of a second on crash.
 */
const STRUCTURAL_WRITE_DEBOUNCE_MS = 300

/**
 * Serializable shape — array of `[manifestKeyString, entry]` tuples.
 * Mirrors `editorStructural`'s internal Map shape but with plain
 * arrays for ComponentEntry tuples (already JSON-safe — they're
 * either strings or InlineComponent objects).
 */
interface PersistedStructural {
  /** Storage-format version for future schema migrations. */
  version: 1
  entries: Array<[string, { original: ComponentEntry[]; pending: ComponentEntry[] }]>
}

export interface PendingEditsPersistenceOptions {
  /**
   * Override the debounce interval. Tests pass 0 to flush
   * synchronously without waiting for real time to pass.
   */
  structuralDebounceMs?: number
}

/**
 * Result of attaching pending-edits persistence — exposes a
 * `dispose()` to detach watchers and a `hydrated` promise that
 * resolves once boot-time hydration completes (so callers can
 * await before mounting any UI that depends on the store state).
 */
export interface PendingEditsPersistenceHandle {
  /** Resolves once hydration finishes. */
  hydrated: Promise<void>
  /** Stop watching + writing. Tests use this for clean teardown. */
  dispose(): void
}

/**
 * Read the persisted structural state from cache and replay every
 * entry into the store. Idempotent: replaying the same entries on
 * an empty store reproduces the persisted state; on a non-empty
 * store it's a no-op for matching keys (Map.set replaces).
 */
async function hydrateStructural(cache: AdminCache): Promise<void> {
  const persisted = await cache.get<PersistedStructural>(STRUCTURAL_KEY)
  if (!persisted || persisted.version !== 1) return
  const store = useEditorStructuralStore()
  for (const [keyString, entry] of persisted.entries) {
    const key = manifestKeyFromString(keyString)
    // Restore via the store's hydration primitive so both `original`
    // (the discard baseline) and `pending` (the user's WIP) come
    // through as-is. The intent-named mutators would re-record
    // `original` from the current call site — wrong for restoration.
    store._hydrateFromSnapshot(key, entry)
  }
}

/**
 * Snapshot the structural store and write it to the cache. Called
 * from a debounced watcher; never throws on cache failures (the
 * AdminCache contract is fail-open per `design-cache.md` Q4).
 */
async function persistStructural(cache: AdminCache): Promise<void> {
  const store = useEditorStructuralStore()
  // The store exposes `entries` as a reactive Map; `allEntries()`
  // returns a snapshot we can serialize. Each tuple is already
  // [string, StructuralEntry] — we just project StructuralEntry
  // into its plain-data shape (slicing readonly to mutable).
  const entries = store
    .allEntries()
    .map<[string, { original: ComponentEntry[]; pending: ComponentEntry[] }]>(
      ([key, entry]: [string, StructuralEntry]) => [
        key,
        {
          original: entry.original.slice(),
          pending: entry.pending.slice(),
        },
      ],
    )
  if (entries.length === 0) {
    // Empty state — invalidate rather than write `{ entries: [] }`
    // so the next hydrate is a clean miss.
    await cache.invalidate(STRUCTURAL_KEY)
    return
  }
  const payload: PersistedStructural = { version: 1, entries }
  await cache.set(STRUCTURAL_KEY, payload)
}

/**
 * Wire pending-edits persistence on top of an `AdminCache`. Call
 * from admin boot AFTER Pinia is installed; the returned handle's
 * `hydrated` promise resolves when initial state is loaded so the
 * caller can await before mounting any UI that reads the store.
 *
 * Production code mounts this once per admin session. Tests can
 * call it with a fresh cache fixture to drive scenarios.
 */
export function attachPendingEditsPersistence(
  cache: AdminCache,
  opts: PendingEditsPersistenceOptions = {},
): PendingEditsPersistenceHandle {
  const debounceMs = opts.structuralDebounceMs ?? STRUCTURAL_WRITE_DEBOUNCE_MS
  const store = useEditorStructuralStore()

  // Hydrate first — must complete before the watcher is attached
  // or the empty initial-state write would clobber persisted data.
  const hydrated = hydrateStructural(cache)

  // Debounced write. Each store mutation kicks the timer forward;
  // the latest snapshot wins. Deep watch over the entries map so
  // we catch both shape changes (set/delete) and value-replacements
  // (setPending replacing the pending array on an existing key).
  let writeTimer: ReturnType<typeof setTimeout> | null = null
  const stop = watch(
    () => Array.from(store.entries.entries()),
    () => {
      if (writeTimer !== null) clearTimeout(writeTimer)
      writeTimer = setTimeout(() => {
        writeTimer = null
        // Fire-and-forget — cache failures are logged by the
        // AdminCache provider, never propagate to the UI.
        void persistStructural(cache)
      }, debounceMs)
    },
    { deep: true },
  )

  return {
    hydrated,
    dispose() {
      stop()
      if (writeTimer !== null) {
        clearTimeout(writeTimer)
        writeTimer = null
      }
    },
  }
}
