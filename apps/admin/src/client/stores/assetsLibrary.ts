/**
 * Asset library modal — open/close state only.
 *
 * A dedicated store (not a local component ref) because:
 * - The `Cmd+L` keyboard shortcut needs to open the library from anywhere
 *   in the admin shell
 * - The future asset picker (Step 6) will open the library in picker mode
 *   from inside a React rjsf widget
 *
 * Kept deliberately narrow — nothing else. List fetching, upload state, and
 * selection all live in their own stores so changes to one don't touch the
 * others.
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useAssetsLibraryStore = defineStore('assetsLibrary', () => {
  const isOpen = ref(false)

  function open(): void {
    isOpen.value = true
  }

  function close(): void {
    isOpen.value = false
  }

  function toggle(): void {
    isOpen.value = !isOpen.value
  }

  return { isOpen, open, close, toggle }
})
