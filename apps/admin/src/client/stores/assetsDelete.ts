/**
 * Asset deletion — state machine for the "confirm then delete" flow.
 *
 * State diagram:
 *     idle ──ask()──▶ confirming ──confirmDelete()──▶ deleting ──ok──▶ idle
 *                                                         │
 *                                                         ├──409 (refs)──▶ in-use ──replace()──▶ replacing ──ok──▶ idle
 *                                                         │                                        │
 *                                                         │                                        ├──409 (kind)──▶ kind-mismatch
 *                                                         │                                        └──other──▶ error
 *                                                         └──other──▶ error
 *
 * Derived view-variant:
 *   The view needs exactly one of five render modes (plus "hidden"). That
 *   decision is part of the state machine, not the view. `dialogVariant`
 *   exposes it as a single discriminator so the shell `v-if`s on one
 *   value rather than juggling status booleans.
 *
 * Single responsibility: state + derived view-variant. Side effects
 * triggered by successful delete/replace (list refresh, selection clear)
 * live in the shell — they're cross-cutting UI reactions, not state.
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { AssetInUseError, AssetKindMismatchError, type AssetRef, deleteAsset, replaceAsset } from '../api/assets.js'

export type DeleteStatus = 'idle' | 'confirming' | 'deleting' | 'in-use' | 'replacing' | 'kind-mismatch' | 'error'

/**
 * Which dialog body should render. One value, exhaustive. Keeps the view
 * off of multi-boolean branching, which is state-machine logic the store
 * owns.
 */
export type DeleteDialogVariant = 'hidden' | 'confirm' | 'in-use' | 'kind-mismatch' | 'error'

/** Detail payload surfaced when a replace was refused on kind mismatch. */
export interface KindMismatchDetail {
  readonly oldKind: string
  readonly oldMimeCategory: string
  readonly newKind: string
  readonly newMimeCategory: string
}

export const useAssetsDeleteStore = defineStore('assetsDelete', () => {
  const status = ref<DeleteStatus>('idle')
  const assetName = ref<string | null>(null)
  const refs = ref<readonly AssetRef[]>([])
  const errorMessage = ref<string | null>(null)
  const kindMismatch = ref<KindMismatchDetail | null>(null)

  const dialogVariant = computed<DeleteDialogVariant>(() => {
    switch (status.value) {
      case 'idle':
        return 'hidden'
      case 'in-use':
        return 'in-use'
      case 'kind-mismatch':
        return 'kind-mismatch'
      case 'error':
        return 'error'
      case 'confirming':
      case 'deleting':
      case 'replacing':
        // While replacing, keep the in-use body visible so the author sees
        // what refs are about to be rewritten — the shell's footer switches
        // to a progress label based on status.
        return status.value === 'replacing' ? 'in-use' : 'confirm'
    }
  })

  /** Open the confirm dialog for a given asset. Resets any previous state. */
  function ask(name: string): void {
    assetName.value = name
    refs.value = []
    errorMessage.value = null
    kindMismatch.value = null
    status.value = 'confirming'
  }

  /** Close the dialog. Safe to call from any state. */
  function close(): void {
    status.value = 'idle'
    assetName.value = null
    refs.value = []
    errorMessage.value = null
    kindMismatch.value = null
  }

  /**
   * Fire the DELETE request. Resolves true when the server returns 204
   * (asset removed) and the store has returned to idle. Transitions to
   * `in-use` on 409, `error` on other failures — both resolve false.
   */
  async function confirmDelete(): Promise<boolean> {
    if (!assetName.value) return false
    status.value = 'deleting'
    try {
      await deleteAsset(assetName.value)
      close()
      return true
    } catch (err) {
      if (err instanceof AssetInUseError) {
        refs.value = err.refs
        status.value = 'in-use'
        return false
      }
      errorMessage.value = (err as Error).message
      status.value = 'error'
      return false
    }
  }

  /**
   * Atomic replace: rewrite every ref to the current asset → `newName`,
   * then delete the current asset. Only valid while status === 'in-use'
   * (the UI only surfaces this after a failed delete). Resolves true on
   * success, false on kind mismatch or any other failure.
   */
  async function replace(newName: string): Promise<boolean> {
    if (status.value !== 'in-use' || !assetName.value) return false
    const oldName = assetName.value
    status.value = 'replacing'
    try {
      await replaceAsset(oldName, newName)
      close()
      return true
    } catch (err: unknown) {
      if (err instanceof AssetKindMismatchError) {
        kindMismatch.value = {
          oldKind: err.oldKind,
          oldMimeCategory: err.oldMimeCategory,
          newKind: err.newKind,
          newMimeCategory: err.newMimeCategory,
        }
        status.value = 'kind-mismatch'
        return false
      }
      errorMessage.value = err instanceof Error ? err.message : String(err)
      status.value = 'error'
      return false
    }
  }

  /**
   * Return to the in-use view from a kind-mismatch refusal — the author
   * can pick a different replacement. Keeps the original refs list so
   * the next pick has the full context.
   */
  function dismissKindMismatch(): void {
    if (status.value !== 'kind-mismatch') return
    kindMismatch.value = null
    status.value = 'in-use'
  }

  return {
    status,
    assetName,
    refs,
    errorMessage,
    kindMismatch,
    dialogVariant,
    ask,
    close,
    confirmDelete,
    replace,
    dismissKindMismatch,
  }
})
