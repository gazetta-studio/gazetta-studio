<script setup lang="ts">
/**
 * Asset picker modal — "select one asset and return it" mode. Opened by
 * `openAssetPicker()` from any context (including React rjsf widgets via
 * the cross-framework function wrapper).
 *
 * Shares the inner composition (upload, grid, detail) with
 * `AssetLibrary.vue` through `<AssetLibraryContent />`. Adds picker
 * chrome: a confirm button that fires the store's resolver with the
 * current selection, and a cancel button that fires it with `null`.
 *
 * Lifecycle invariant: the store's Promise must always resolve. If the
 * modal unmounts for any reason (route change, user navigates away)
 * without confirm/cancel firing, `onBeforeUnmount` calls `cancel()` so
 * no in-flight picker leaks.
 */
import { computed, watch, onBeforeUnmount } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import { matchesAccept, type AcceptFilter } from 'gazetta/schema'
import { useAssetsPickerStore } from '../stores/assetsPicker.js'
import { useAssetsListStore } from '../stores/assetsList.js'
import { useAssetsSelectionStore } from '../stores/assetsSelection.js'
import AssetLibraryContent from './AssetLibraryContent.vue'

const picker = useAssetsPickerStore()
const list = useAssetsListStore()
const selection = useAssetsSelectionStore()

/**
 * The currently-selected asset's manifest, or `null` when nothing is
 * selected. Used to verify accept-compatibility at confirm time —
 * defence in depth: the grid filters incompatible cards, but if a
 * filter ever drifts (e.g., race with a list refresh), the confirm
 * button is the last line that prevents an incompatible ref from
 * landing in the page manifest.
 */
const selectedAsset = computed(() => {
  if (!selection.selectedName) return null
  return list.assets.find(a => a.name === selection.selectedName) ?? null
})

const selectionMatchesAccept = computed(() => {
  if (picker.accept.length === 0) return true
  if (!selectedAsset.value) return false
  return matchesAccept(selectedAsset.value, picker.accept as AcceptFilter[])
})

const visible = computed({
  get: () => picker.isOpen,
  // Closing via the dialog's own X or ESC is treated as cancel.
  set: (v: boolean) => {
    if (!v) picker.cancel()
  },
})

// When the picker opens, refresh the list and pre-select the current asset
// (if any). Clear selection when the modal closes so a subsequent picker
// doesn't inherit the previous selection.
watch(
  () => picker.isOpen,
  open => {
    if (open) {
      void list.refresh()
      selection.selectedName = picker.currentAssetName
    } else {
      selection.clear()
    }
  },
)

function onConfirm(): void {
  if (!selection.selectedName) return
  // Defence in depth: refuse to confirm an incompatible selection even
  // though the grid filters them out. Future bypass (a non-grid
  // selection path, a stale-list race) shouldn't land an incompatible
  // ref in the page manifest.
  if (!selectionMatchesAccept.value) return
  picker.confirm(selection.selectedName)
}

function onCancel(): void {
  picker.cancel()
}

// Belt-and-suspenders: if this component unmounts while a picker is
// active (route change, parent disposal), cancel so the Promise doesn't
// leak waiting for a confirm that can never happen.
onBeforeUnmount(() => {
  if (picker.isOpen) picker.cancel()
})
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    :style="{ width: '80vw', maxWidth: '1200px', height: '80vh' }"
    header="Select an asset"
    data-testid="asset-picker">
    <AssetLibraryContent />
    <template #footer>
      <div class="asset-picker-footer">
        <Button
          label="Cancel"
          text
          data-testid="asset-picker-cancel"
          @click="onCancel" />
        <Button
          label="Select"
          :disabled="!selection.selectedName || !selectionMatchesAccept"
          data-testid="asset-picker-confirm"
          @click="onConfirm" />
      </div>
    </template>
  </Dialog>
</template>

<style scoped>
.asset-picker-footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
</style>
