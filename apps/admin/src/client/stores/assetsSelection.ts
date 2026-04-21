/**
 * Asset selection — which asset is currently selected in the library.
 *
 * Single responsibility: selection state. v1 slice is single-select only
 * (the detail pane shows one asset at a time). Multi-select and bulk
 * operations come later.
 *
 * Selection is by asset name (the stable identity), not by index or by
 * object reference — indexes shift when the list refreshes, and refs
 * don't survive store hydration.
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useAssetsSelectionStore = defineStore('assetsSelection', () => {
  const selectedName = ref<string | null>(null)

  function select(name: string): void {
    selectedName.value = name
  }

  function clear(): void {
    selectedName.value = null
  }

  /** True when the named asset is selected. */
  function isSelected(name: string): boolean {
    return selectedName.value === name
  }

  return { selectedName, select, clear, isSelected }
})
