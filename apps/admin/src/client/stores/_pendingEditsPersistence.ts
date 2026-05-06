/**
 * Pending-edits persistence — bridges the in-memory pending-edits
 * Pinia stores to the L6 `AdminCache` so edits survive browser
 * reload per `design-offline.md`'s "Pending edits persist across
 * browser reload" invariant.
 *
 * # Two coordinators, two stores
 *
 * Cut 8a + Cut 8b together cover the three pending-edits stores:
 *
 *   `attachPendingEditsPersistence` (Cut 8a)
 *     persists `editorStructural` (component reorder / add / remove)
 *
 *   `attachPersistedEditsPersistence` (Cut 8b)
 *     persists `usePersistedEditsStore` — a cross-page-correct mirror
 *     of `editorStash` + `editorContent` dirty state, keyed by
 *     `(kind, name, locale, path)` tuples so two pages with a
 *     `_root` or `hero` selection don't collide
 *
 * Both follow the same shape: hydrate at boot, deep-watch the
 * source store, debounce-write a JSON snapshot to the cache.
 *
 * # SOLID lenses
 *
 *   - SRP: this module owns persistence-coordination. Stores stay
 *     store-shaped (state + mutations); the coordinators observe +
 *     serialize + hydrate externally.
 *   - DIP: both `attach...` functions take any `AdminCache`. The
 *     selector picks IndexedDB or memory; the coordinators don't
 *     care which.
 *   - OCP: a third store (e.g., a future per-asset upload-queue)
 *     plugs in via another `attach...()` without changing what's
 *     here.
 *
 * # Cache key conventions
 *
 * Per `design-cache.md` Q1, reserved prefix is `pending-edits:`.
 *
 *   `pending-edits:structural`  — Cut 8a's editorStructural snapshot
 *   `pending-edits:dirty`       — Cut 8b's usePersistedEdits snapshot
 */
import { watch } from 'vue'
import type { AdminCache } from 'gazetta'
import type { ComponentEntry, ManifestKey } from 'gazetta/types'
import { manifestKeyFromString } from 'gazetta/types'
import { useEditorStructuralStore, type StructuralEntry } from './editorStructural.js'
import { type PersistedEdit, usePersistedEditsStore } from './persistedEdits.js'

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
    let key
    try {
      key = manifestKeyFromString(keyString)
    } catch {
      // Malformed entry — could happen if a future schema change
      // wrote a key shape we don't recognize, or storage was
      // corrupted out-of-band. Skip the bad entry; restore the
      // valid ones. Better than killing hydration for ALL entries
      // because of one bad one.
      continue
    }
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

// === Cut 8b: persisted dirty + stashed edits ============================

/** Cache key for the cross-page persisted-edits snapshot. */
const PERSISTED_EDITS_KEY = 'pending-edits:dirty'

/** Default debounce window — slightly slower than structural since
 *  field edits fire on every keystroke; rapid coalescing avoids
 *  IndexedDB write thrash during typing. */
const PERSISTED_EDITS_WRITE_DEBOUNCE_MS = 500

interface PersistedEditsSnapshot {
  version: 1
  entries: Array<[string, PersistedEdit]>
}

async function hydratePersistedEdits(cache: AdminCache): Promise<void> {
  const persisted = await cache.get<PersistedEditsSnapshot>(PERSISTED_EDITS_KEY)
  if (!persisted || persisted.version !== 1) return
  const store = usePersistedEditsStore()
  // Filter out malformed entries — same defensive posture as Cut 8a's
  // structural hydration. One bad row shouldn't kill restoration of
  // the rest.
  const valid: Array<[string, PersistedEdit]> = []
  for (const [key, entry] of persisted.entries) {
    if (typeof key !== 'string' || !entry || typeof entry !== 'object') continue
    if (typeof entry.editedContent !== 'object' || entry.editedContent === null) continue
    valid.push([key, entry])
  }
  store._hydrateAll(valid)
}

async function persistPersistedEdits(cache: AdminCache): Promise<void> {
  const store = usePersistedEditsStore()
  const entries = [...store.entries.entries()]
  if (entries.length === 0) {
    await cache.invalidate(PERSISTED_EDITS_KEY)
    return
  }
  const payload: PersistedEditsSnapshot = { version: 1, entries }
  await cache.set(PERSISTED_EDITS_KEY, payload)
}

export interface PersistedEditsPersistenceOptions {
  /** Override the debounce interval. Tests pass 0 to flush
   *  synchronously without waiting for real time to pass. */
  debounceMs?: number
}

/**
 * Wire persistence for `usePersistedEditsStore` (the cross-page
 * dirty + stashed mirror introduced by Cut 8b). Same shape as
 * `attachPendingEditsPersistence` from Cut 8a; lives in this file
 * because it's the same persistence-coordinator concern.
 */
export function attachPersistedEditsPersistence(
  cache: AdminCache,
  opts: PersistedEditsPersistenceOptions = {},
): PendingEditsPersistenceHandle {
  const debounceMs = opts.debounceMs ?? PERSISTED_EDITS_WRITE_DEBOUNCE_MS
  const store = usePersistedEditsStore()

  const hydrated = hydratePersistedEdits(cache)

  let writeTimer: ReturnType<typeof setTimeout> | null = null
  const stop = watch(
    () => Array.from(store.entries.entries()),
    () => {
      if (writeTimer !== null) clearTimeout(writeTimer)
      writeTimer = setTimeout(() => {
        writeTimer = null
        void persistPersistedEdits(cache)
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
