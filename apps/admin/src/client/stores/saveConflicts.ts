/**
 * Save-conflict state per `design-offline.md` Q3 + Q4.
 *
 * Holds conflict snapshots keyed by manifest path (`pages/home/page.json`
 * | `fragments/header/fragment.json`). When the save flow's
 * `StaleSaveError` surfaces, the catching layer registers the conflict
 * here; the banner UI reads it and offers two actions:
 *
 *   - "Discard my changes" → clears the conflict + the local pending edit
 *   - "Show what changed"  → opens the diff view; banner stays until
 *                            the author finishes acting
 *
 * Conflicts persist across navigation (per Q4): an author can navigate
 * away, come back, and the banner is still there. Per the Krug-aligned
 * lock there is no explicit "Dismiss" action — dismissing a conflict
 * without resolving it is a footgun (the next save would still 409).
 *
 * # SOLID lenses
 *
 *   - SRP: this store owns "what conflicts exist right now and on which
 *     items." It does NOT know how saves produce conflicts (that's
 *     useEditorActions when 9b ships) or how the banner renders them
 *     (ConflictBanner.vue).
 *   - DIP: consumers depend on the store's typed API; the underlying
 *     `Map<string, ConflictRecord>` is implementation detail.
 *
 * # Why keyed by manifest path, not page name
 *
 * Two manifests can have the same name across kinds (a page named
 * "header" + a fragment named "header"). The conflict surface is at
 * the file boundary, so the path is the correct identity.
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export interface ConflictRecord {
  /**
   * Manifest path — uniquely identifies the file in conflict.
   * Examples: `pages/home/page.json`, `fragments/header/fragment.json`,
   * `pages/about/page.fr.json` (locale variant).
   */
  itemPath: string
  /** The server's current manifest at the time the 409 STALE arrived. */
  current: Record<string, unknown>
  /** The server's current save-etag — re-send as If-Match after rebase. */
  currentEtag: string
  /**
   * The author's pending content at the time the save attempt was made.
   * Frozen at conflict-detection time so subsequent edits don't change
   * what the diff view shows.
   */
  pending: Record<string, unknown>
  /** ISO timestamp when the conflict was detected. */
  surfacedAt: string
}

export const useSaveConflictsStore = defineStore('saveConflicts', () => {
  const conflicts = ref<Map<string, ConflictRecord>>(new Map())

  /**
   * Register a new conflict for `itemPath`. Overwrites any existing
   * conflict on the same path — the freshest 409 is always the one
   * the author needs to resolve.
   */
  function set(record: Omit<ConflictRecord, 'surfacedAt'>): void {
    const next = new Map(conflicts.value)
    next.set(record.itemPath, { ...record, surfacedAt: new Date().toISOString() })
    conflicts.value = next
  }

  /** Resolve the conflict for `itemPath` (e.g., after Discard). */
  function clear(itemPath: string): void {
    if (!conflicts.value.has(itemPath)) return
    const next = new Map(conflicts.value)
    next.delete(itemPath)
    conflicts.value = next
  }

  /** Drop all conflicts. Used on logout, target-switch, etc. */
  function clearAll(): void {
    conflicts.value = new Map()
  }

  function get(itemPath: string): ConflictRecord | null {
    return conflicts.value.get(itemPath) ?? null
  }

  function has(itemPath: string): boolean {
    return conflicts.value.has(itemPath)
  }

  const count = computed(() => conflicts.value.size)
  const hasAny = computed(() => conflicts.value.size > 0)

  return {
    conflicts,
    count,
    hasAny,
    set,
    clear,
    clearAll,
    get,
    has,
  }
})
