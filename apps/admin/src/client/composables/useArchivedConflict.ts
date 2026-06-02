/**
 * Archived-name-conflict orchestrator. Extracted at the rule-15
 * 3-caller threshold (#486) from CreatePageDialog, CreateFragmentDialog,
 * and CreateRedirectDialog, each of which had been carrying a near-
 * identical copy of:
 *
 *   - `conflict` ref<ArchivedNameConflictDetails | null>
 *   - try { await post(); await side-effects() }
 *     catch (err) {
 *       if (err instanceof ArchivedNameConflictError) conflict.value = err.archive
 *       else error.value = (err as Error).message
 *     }
 *   - `handleResolve(mode)` → re-issues the same POST with `{ onConflict: mode }`
 *   - `handleConflictCancel()` → clears conflict + error
 *
 * # SOLID lenses
 *
 *   - SRP: this composable owns "translate an archived-name-conflict
 *     into the morph-prompt state machine + replay loop." Consumers
 *     own the POST closure, the success side-effects, and any
 *     dialog-specific UI (kind toggle, derived previews, etc.).
 *   - DIP: callers pass `attempt` + `onSuccess` closures; the
 *     composable knows nothing about pagesApi, fragmentsApi, or
 *     redirectsApi — it depends only on `ArchivedNameConflictError`
 *     from the api client.
 *   - OCP: adding a fourth caller (a future Create* dialog) means
 *     consuming this composable, not editing it. Adding a resolution
 *     mode (e.g. a future "merge") extends `ResolutionMode` once
 *     and is picked up by every consumer.
 *
 * # Why a closure, not the URL itself
 *
 * The composable takes an `attempt` callback rather than a fetch URL
 * + body. Two reasons: (1) the three callers exercise different api
 * methods (`createPage`, `createFragment`, `createPageRedirect`,
 * `createFragmentRedirect`), each with its own request shape; (2) the
 * normalization step (derived names, prefix-strip) is dialog-specific
 * and is run at call time. The closure reads dynamic state from the
 * dialog's refs naturally.
 */
import { ref, type Ref } from 'vue'
import { ArchivedNameConflictError, type ArchivedNameConflictDetails } from '../api/client.js'

export type ResolutionMode = 'restore' | 'replace' | 'moveAside'

export interface ArchivedConflictAttemptOptions {
  onConflict?: ResolutionMode
}

export interface UseArchivedConflictOptions {
  /**
   * The kind-specific POST. Called with `undefined` on the initial
   * attempt and with `{ onConflict: mode }` when the author chooses
   * a resolution from the prompt. The closure reads dialog state
   * (name, template, kind, etc.) at call time.
   */
  attempt: (opts?: ArchivedConflictAttemptOptions) => Promise<unknown>
  /**
   * Side-effect on successful create — typically `await site.load()`
   * or `await site.reload()` followed by `emit('close')`. Runs only
   * when `attempt` resolves; skipped on both conflict and non-conflict
   * error paths.
   */
  onSuccess?: () => void | Promise<void>
}

export interface UseArchivedConflictHandle {
  conflict: Ref<ArchivedNameConflictDetails | null>
  error: Ref<string | null>
  busy: Ref<boolean>
  /**
   * Initial attempt. Equivalent to `handleResolve` without a mode,
   * named for the consuming dialog's "Create" button which calls
   * `attempt` with no opts.
   */
  run(): Promise<void>
  /** Author chose Restore / Replace / Move-aside; re-issues `attempt`
   *  with `{ onConflict: mode }`. */
  handleResolve(mode: ResolutionMode): Promise<void>
  /** Author dismissed the morph prompt; clears the conflict + error
   *  refs so the dialog body re-renders the create form. */
  handleConflictCancel(): void
}

export function useArchivedConflict(opts: UseArchivedConflictOptions): UseArchivedConflictHandle {
  const conflict = ref<ArchivedNameConflictDetails | null>(null)
  const error = ref<string | null>(null)
  const busy = ref(false)

  async function execute(attemptOpts?: ArchivedConflictAttemptOptions): Promise<void> {
    busy.value = true
    error.value = null
    try {
      await opts.attempt(attemptOpts)
      if (opts.onSuccess) await opts.onSuccess()
    } catch (err) {
      if (err instanceof ArchivedNameConflictError) {
        conflict.value = err.archive
      } else {
        error.value = (err as Error).message
      }
    } finally {
      busy.value = false
    }
  }

  return {
    conflict,
    error,
    busy,
    run: () => execute(undefined),
    handleResolve: (mode: ResolutionMode) => execute({ onConflict: mode }),
    handleConflictCancel() {
      conflict.value = null
      error.value = null
    },
  }
}
