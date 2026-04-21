/**
 * Register the `Cmd+L` / `Ctrl+L` keyboard shortcut that toggles the asset
 * library modal.
 *
 * Single responsibility: this binding and only this binding. The store owns
 * the modal state; this composable only wires the shortcut to it. Mirrors
 * the existing `useWorkspaceChrome()` pattern — App.vue invokes it once at
 * setup time; the binding lives for the lifetime of the app.
 */
import { onKeyStroke } from '@vueuse/core'
import { useAssetsLibraryStore } from '../stores/assetsLibrary.js'

export function useAssetLibraryShortcut(): void {
  const library = useAssetsLibraryStore()
  onKeyStroke('l', e => {
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault()
      library.toggle()
    }
  })
}
