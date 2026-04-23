/**
 * Asset deletion — state for the "confirm then delete" flow.
 *
 * Three states the UI needs to render:
 * - Closed (default): no dialog shown.
 * - Confirming: dialog asking "Delete <name>?" with Cancel / Delete buttons.
 *   No refs list yet — the server hasn't been asked.
 * - In-use: the DELETE request returned 409 with a usage list. Dialog switches
 *   to the refuse-with-usage view; "Delete" is replaced by "Close".
 *
 * Single responsibility: modal state for the confirm dialog. Doesn't own the
 * list-refresh side effect (that's triggered on successful delete by the
 * component, which calls `list.refresh()` directly — same pattern as upload).
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api, AssetInUseError, type AssetRefShape } from '../api/client.js'

type Status = 'idle' | 'confirming' | 'deleting' | 'in-use' | 'error'

export const useAssetsDeleteStore = defineStore('assetsDelete', () => {
  const status = ref<Status>('idle')
  const assetName = ref<string | null>(null)
  const refs = ref<readonly AssetRefShape[]>([])
  const errorMessage = ref<string | null>(null)

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
   * Fire the DELETE request. Resolves when the server returns 204 (asset
   * removed); transitions to `in-use` on 409, `error` on other failures.
   * Returns `true` when the asset was successfully deleted, `false` otherwise.
   */
  async function confirmDelete(): Promise<boolean> {
    if (!assetName.value) return false
    status.value = 'deleting'
    try {
      await api.deleteAsset(assetName.value)
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

  return { status, assetName, refs, errorMessage, ask, close, confirmDelete }
})
