/**
 * Asset deletion — state machine for the "confirm then delete" flow.
 *
 * State diagram:
 *     idle ──ask()──▶ confirming ──confirmDelete()──▶ deleting ──success──▶ idle
 *                                                          │
 *                                                          ├──409──▶ in-use
 *                                                          └──other──▶ error
 *
 * Derived view-variant:
 *   The view needs exactly one of three render modes (plus "hidden"). That
 *   decision is part of the state machine, not the view. `dialogVariant`
 *   exposes it as a single discriminator so the shell `v-if`s on one
 *   value rather than juggling three status booleans.
 *
 * Single responsibility: state + derived view-variant. Side effects
 * triggered by successful delete (list refresh, selection clear) live in
 * the shell — they're cross-cutting UI reactions, not state.
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { AssetInUseError, type AssetRef, deleteAsset } from '../api/assets.js'

export type DeleteStatus = 'idle' | 'confirming' | 'deleting' | 'in-use' | 'error'

/**
 * Which dialog body should render. One value, exhaustive. Keeps the view
 * off of multi-boolean branching (`!isInUse && !isError`), which is
 * state-machine logic the store owns.
 */
export type DeleteDialogVariant = 'hidden' | 'confirm' | 'in-use' | 'error'

export const useAssetsDeleteStore = defineStore('assetsDelete', () => {
  const status = ref<DeleteStatus>('idle')
  const assetName = ref<string | null>(null)
  const refs = ref<readonly AssetRef[]>([])
  const errorMessage = ref<string | null>(null)

  /**
   * The dialog body the view should render, derived from `status`. One
   * discriminator for the shell to switch on — `'hidden'` means the
   * modal is closed; the other three each map to one body component.
   */
  const dialogVariant = computed<DeleteDialogVariant>(() => {
    switch (status.value) {
      case 'idle':
        return 'hidden'
      case 'in-use':
        return 'in-use'
      case 'error':
        return 'error'
      case 'confirming':
      case 'deleting':
        return 'confirm'
    }
  })

  /** Open the confirm dialog for a given asset. Resets any previous state. */
  function ask(name: string): void {
    assetName.value = name
    refs.value = []
    errorMessage.value = null
    status.value = 'confirming'
  }

  /** Close the dialog. Safe to call from any state. */
  function close(): void {
    status.value = 'idle'
    assetName.value = null
    refs.value = []
    errorMessage.value = null
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

  return { status, assetName, refs, errorMessage, dialogVariant, ask, close, confirmDelete }
})
