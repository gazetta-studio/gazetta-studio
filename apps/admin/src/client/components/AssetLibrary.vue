<script setup lang="ts">
/**
 * Asset library modal — browsing mode. Visibility is driven by the
 * `assetsLibrary` store so the `Cmd+L` shortcut can open it from anywhere.
 *
 * This component owns browsing chrome only. The shared inner composition
 * (upload + grid + detail) lives in `AssetLibraryContent.vue` so the
 * picker modal can reuse it without duplication.
 */
import { computed, watch } from 'vue'
import Dialog from 'primevue/dialog'
import { useAssetsLibraryStore } from '../stores/assetsLibrary.js'
import { useAssetsListStore } from '../stores/assetsList.js'
import { useAssetsSelectionStore } from '../stores/assetsSelection.js'
import AssetLibraryContent from './AssetLibraryContent.vue'

const library = useAssetsLibraryStore()
const list = useAssetsListStore()
const selection = useAssetsSelectionStore()

const visible = computed({
  get: () => library.isOpen,
  set: (v: boolean) => (v ? library.open() : library.close()),
})

// Refresh the list each time the modal opens so authors see newly uploaded
// assets without a manual refresh. Initial load happens on first open.
watch(
  () => library.isOpen,
  open => {
    if (open) void list.refresh()
    else selection.clear()
  },
)
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    :style="{ width: '80vw', maxWidth: '1200px', height: '80vh' }"
    header="Asset library"
    data-testid="asset-library">
    <AssetLibraryContent />
  </Dialog>
</template>
