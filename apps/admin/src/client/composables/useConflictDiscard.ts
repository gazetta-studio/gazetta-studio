/**
 * Conflict-discard orchestrator per `design-offline.md` Q3.
 *
 * When the author clicks "Discard my changes" on the conflict
 * banner (Cut 10), three things must happen in order:
 *
 *   1. Clear the conflict store entry for the active item — the
 *      banner closes
 *   2. Drop the editor's local pending edits — `editing.discard()`
 *   3. Reload the selection from the server — pulls fresh manifest
 *      + fresh save-etag in one round trip; clears any stale state
 *
 * # Why a composable, not inline in EditorPanel.vue
 *
 * The orchestration lives at the composable layer (per
 * `useEditorActions` precedent); EditorPanel renders the visible
 * state. Extracting the discard flow as `useConflictDiscard` makes
 * it independently testable without mounting the editor's
 * real-DOM machinery (editor-mount.ts, jiti-loaded custom editors,
 * @rjsf React tree).
 *
 * # SOLID lenses
 *
 *   - SRP: this composable owns "translate a conflict-banner
 *     discard action into the right side effects." It does NOT
 *     own the conflict state, the editor state, or the selection
 *     state — just the orchestration.
 *   - DIP: callers pass an `itemPath` (already computed by the
 *     consuming component); the composable depends on the typed
 *     store APIs.
 *
 * # Why reload, not "apply current.content directly"
 *
 * The conflict record carries the server's `current` manifest, so
 * we COULD apply it directly. But:
 *
 *   - The current shape may differ from what the editor needs
 *     (route is derived; component children may have changed)
 *   - We need a fresh save-etag for the next save attempt; reload
 *     fetches both manifest + etag in one go
 *
 * Reload via `selection.reload()` covers every edit context (root,
 * component, fragment) uniformly. Cheaper-than-strictly-necessary
 * but uniformly correct.
 */
import { useEditingStore } from '../stores/editing.js'
import { useSaveConflictsStore } from '../stores/saveConflicts.js'
import { useSelectionStore } from '../stores/selection.js'

export interface ConflictDiscardHandle {
  /**
   * Run the discard flow for `itemPath`. Idempotent: calling on a
   * path that has no conflict still drops local edits + reloads
   * (the banner shouldn't be visible in that case, but the action
   * is safe regardless).
   */
  run(itemPath: string): Promise<void>
}

/**
 * Composable that returns a `run` function. Production code wires
 * this to the ConflictBanner's `@discard` event in EditorPanel.vue;
 * tests construct it with a fresh Pinia and assert the side effects.
 */
export function useConflictDiscard(): ConflictDiscardHandle {
  const conflicts = useSaveConflictsStore()
  const editing = useEditingStore()
  const selection = useSelectionStore()

  return {
    async run(itemPath: string): Promise<void> {
      conflicts.clear(itemPath)
      editing.discard()
      await selection.reload()
    },
  }
}
