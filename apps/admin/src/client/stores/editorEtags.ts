/**
 * Save-concurrency etag tracker per `design-offline.md` Q3.
 *
 * Holds the latest server-issued save-etag for each manifest the
 * client has read or written. The save flow sends the stored value
 * as `If-Match` and updates it from the server's response on success.
 * The conflict flow updates it from the 409 STALE response's
 * `currentEtag` so the next save chains correctly.
 *
 * # Shape
 *
 * Keyed by manifest path (`pages/home/page.json`, `fragments/header/
 * fragment.json`, `pages/about/page.fr.json`). Same key shape as
 * `useSaveConflictsStore` so cross-store coordination is trivial.
 *
 * # SOLID lenses
 *
 *   - SRP: this store owns "what's the latest etag for each
 *     manifest." It does NOT know how saves consume the etag
 *     (that's useEditorActions) or how conflicts use it (that's
 *     ConflictBanner).
 *   - DIP: consumers depend on the typed store API; the underlying
 *     Map is an implementation detail.
 *
 * # Why not bundle on `EditingTarget`
 *
 * Two reasons. First, the editor's active target is component-scoped
 * (`pages/home/hero`); the etag is manifest-scoped (`pages/home/page.json`).
 * Multiple components in one page share one etag. Second, the stash
 * stashes the whole `EditingTarget`; tracking the etag separately
 * means the stash + active editor + future load paths all read from
 * one source of truth without each carrying its own copy.
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/**
 * Build the manifest path for a (kind, name, locale?) tuple. Same
 * format as `useSaveConflictsStore` keys.
 */
export function manifestPath(kind: 'page' | 'fragment', name: string, locale?: string): string {
  if (kind === 'page') {
    return locale ? `pages/${name}/page.${locale}.json` : `pages/${name}/page.json`
  }
  return locale ? `fragments/${name}/fragment.${locale}.json` : `fragments/${name}/fragment.json`
}

export const useEditorEtagsStore = defineStore('editorEtags', () => {
  const etags = ref<Map<string, string>>(new Map())

  function set(itemPath: string, etag: string): void {
    const next = new Map(etags.value)
    next.set(itemPath, etag)
    etags.value = next
  }

  function get(itemPath: string): string | null {
    return etags.value.get(itemPath) ?? null
  }

  function clear(itemPath: string): void {
    if (!etags.value.has(itemPath)) return
    const next = new Map(etags.value)
    next.delete(itemPath)
    etags.value = next
  }

  function clearAll(): void {
    etags.value = new Map()
  }

  const count = computed(() => etags.value.size)

  return { etags, count, set, get, clear, clearAll }
})
