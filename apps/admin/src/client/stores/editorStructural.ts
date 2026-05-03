import { defineStore } from 'pinia'
import { reactive, computed } from 'vue'
import type { ComponentEntry, InlineComponent, ManifestKey } from 'gazetta/types'
import { manifestKeyToString } from 'gazetta/types'

/**
 * One pending structural edit — both the original (for discard) and the
 * current pending state. The original is captured the first time a mutation
 * is applied for a key; subsequent mutations operate on `pending`.
 */
export interface StructuralEntry {
  original: readonly ComponentEntry[]
  pending: ComponentEntry[]
}

/**
 * Pending structural changes (move / add / remove of components on a page or
 * fragment manifest). Peer to {@link useEditorStashStore} which holds pending
 * content edits. Both lanes are flushed atomically by the editor save pipeline.
 *
 * Single-page focus: in v1 the UX limits structural pending to the
 * currently-focused page/fragment. The store's Map is keyed by `ManifestKey`
 * for forward-compat — multi-page support is a UX call away, not a state
 * rewrite.
 *
 * Pure state — no side effects, no other-store dependencies. Mutations are
 * intent-named (move / add / remove) so callers express intent and the store
 * enforces array shape.
 */
export const useEditorStructuralStore = defineStore('editorStructural', () => {
  const entries = reactive<Map<string, StructuralEntry>>(new Map())

  /**
   * Seed an entry from the current disk-loaded array if not present, returning
   * a writable copy of `pending` for the next mutation to operate on. Both
   * `original` and `pending` start as independent copies of the input.
   */
  function ensureEntry(key: ManifestKey, current: readonly ComponentEntry[]): StructuralEntry {
    const k = manifestKeyToString(key)
    const existing = entries.get(k)
    if (existing) return existing
    const seeded: StructuralEntry = {
      original: current.slice(),
      pending: current.slice(),
    }
    entries.set(k, seeded)
    return seeded
  }

  function moveComponent(key: ManifestKey, current: readonly ComponentEntry[], fromIndex: number, toIndex: number) {
    if (fromIndex === toIndex) return
    if (fromIndex < 0 || fromIndex >= current.length) return
    if (toIndex < 0 || toIndex >= current.length) return
    const entry = ensureEntry(key, current)
    const [moved] = entry.pending.splice(fromIndex, 1)
    entry.pending.splice(toIndex, 0, moved)
  }

  function addComponent(
    key: ManifestKey,
    current: readonly ComponentEntry[],
    component: InlineComponent | string,
    insertIndex?: number,
  ) {
    const entry = ensureEntry(key, current)
    const idx = insertIndex ?? entry.pending.length
    entry.pending.splice(idx, 0, component)
  }

  function removeComponent(key: ManifestKey, current: readonly ComponentEntry[], atIndex: number) {
    if (atIndex < 0 || atIndex >= current.length) return
    const entry = ensureEntry(key, current)
    entry.pending.splice(atIndex, 1)
  }

  /**
   * Drop the pending entry for a key, reverting to disk-loaded order on next read.
   * No-op when no entry exists for the key.
   */
  function discard(key: ManifestKey) {
    entries.delete(manifestKeyToString(key))
  }

  function clearAll() {
    entries.clear()
  }

  /** Current pending components for a key, or null if no entry exists. */
  function pendingFor(key: ManifestKey): ComponentEntry[] | null {
    return entries.get(manifestKeyToString(key))?.pending ?? null
  }

  function hasPendingFor(key: ManifestKey): boolean {
    return entries.has(manifestKeyToString(key))
  }

  /** All pending entries — consumers iterate to build the save payload + preview overrides. */
  function allEntries(): Array<[string, StructuralEntry]> {
    return [...entries.entries()]
  }

  const pendingCount = computed(() => entries.size)
  const hasPendingEdits = computed(() => entries.size > 0)

  return {
    entries,
    moveComponent,
    addComponent,
    removeComponent,
    discard,
    clearAll,
    pendingFor,
    hasPendingFor,
    allEntries,
    pendingCount,
    hasPendingEdits,
  }
})
