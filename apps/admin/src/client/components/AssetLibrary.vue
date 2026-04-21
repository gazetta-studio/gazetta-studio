<script setup lang="ts">
/**
 * Asset library modal — the shell that composes the grid, upload zone, and
 * detail pane. Visibility is driven by the `assetsLibrary` store so the
 * `Cmd+L` shortcut and the future picker entry point can both open it.
 *
 * Layout:
 *   +----------------------------------------+
 *   | Title             Close                |
 *   +-----------------------------+----------+
 *   | Upload zone                 |          |
 *   |                             |  Detail  |
 *   | Grid of assets              |  pane    |
 *   |                             |          |
 *   +-----------------------------+----------+
 *
 * Desktop-only layout. The admin assumes desktop per operations.md and
 * team-preferences; no responsive breakpoints here.
 */
import { computed, watch } from 'vue'
import Dialog from 'primevue/dialog'
import { useAssetsLibraryStore } from '../stores/assetsLibrary.js'
import { useAssetsListStore } from '../stores/assetsList.js'
import { useAssetsSelectionStore } from '../stores/assetsSelection.js'
import AssetLibraryGrid from './AssetLibraryGrid.vue'
import AssetUploadZone from './AssetUploadZone.vue'
import AssetDetail from './AssetDetail.vue'

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
    <div class="asset-library-body">
      <div class="asset-library-main">
        <AssetUploadZone />
        <AssetLibraryGrid />
      </div>
      <div class="asset-library-side">
        <AssetDetail />
      </div>
    </div>
  </Dialog>
</template>

<style scoped>
.asset-library-body {
  display: grid;
  grid-template-columns: 1fr 320px;
  gap: 1rem;
  height: 100%;
  min-height: 400px;
}

.asset-library-main {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-height: 0;
}

.asset-library-side {
  border-inline-start: 1px solid var(--p-content-border-color);
  padding-inline-start: 1rem;
  min-height: 0;
  overflow-y: auto;
}
</style>
