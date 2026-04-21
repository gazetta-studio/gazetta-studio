<script setup lang="ts">
/**
 * Inner composition shared between the browsing library modal and the
 * picker modal. Renders: upload zone, grid, detail pane. No modal chrome
 * — the parent owns that.
 *
 * Props-less and emit-less: state lives in the stores. The parent is
 * responsible for calling `list.refresh()` when it opens, and for the
 * surrounding modal's lifecycle (open/close, confirm button, etc.).
 */
import AssetLibraryGrid from './AssetLibraryGrid.vue'
import AssetUploadZone from './AssetUploadZone.vue'
import AssetDetail from './AssetDetail.vue'
</script>

<template>
  <div class="asset-library-content" data-testid="asset-library-content">
    <div class="asset-library-main">
      <AssetUploadZone />
      <AssetLibraryGrid />
    </div>
    <div class="asset-library-side">
      <AssetDetail />
    </div>
  </div>
</template>

<style scoped>
.asset-library-content {
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
