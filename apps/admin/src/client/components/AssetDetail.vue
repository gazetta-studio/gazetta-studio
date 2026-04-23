<script setup lang="ts">
/**
 * Asset detail pane — shows metadata for the selected asset from the grid.
 * No edit affordances in v1; authors can edit in a later step once the
 * persistence path is in place (PATCH /api/assets/:name).
 *
 * Reads from `assetsSelection` + `assetsList`. If the selection points to
 * an asset not in the list (stale after a refresh), shows an empty state.
 */
import { computed } from 'vue'
import Button from 'primevue/button'
import { useAssetsListStore } from '../stores/assetsList.js'
import { useAssetsSelectionStore } from '../stores/assetsSelection.js'
import { useAssetsDeleteStore } from '../stores/assetsDelete.js'
import { buildAssetUrl, extFromMime } from '../utils/assetUrl.js'

const list = useAssetsListStore()
const selection = useAssetsSelectionStore()
const del = useAssetsDeleteStore()

function onDelete(): void {
  if (!asset.value) return
  del.ask(asset.value.name)
}

const asset = computed(() => {
  if (!selection.selectedName) return null
  return list.assets.find(a => a.name === selection.selectedName) ?? null
})

const previewUrl = computed(() => {
  if (!asset.value) return null
  const ext = extFromMime(asset.value.mime)
  if (!ext) return null
  return buildAssetUrl({ name: asset.value.name, hash: asset.value.hash, ext })
})

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}
</script>

<template>
  <div class="asset-detail" data-testid="asset-detail">
    <div v-if="!asset" class="asset-detail-empty" data-testid="asset-detail-empty">
      Select an asset to view details.
    </div>
    <div v-else class="asset-detail-body">
      <div v-if="previewUrl" class="asset-detail-preview">
        <img :src="previewUrl" :alt="asset.alt ?? ''" />
      </div>
      <h2 class="asset-detail-name" data-testid="asset-detail-name">{{ asset.name }}</h2>
      <dl class="asset-detail-fields">
        <div>
          <dt>Kind</dt>
          <dd>{{ asset.kind }}</dd>
        </div>
        <div>
          <dt>Type</dt>
          <dd>{{ asset.mime }}</dd>
        </div>
        <div>
          <dt>Size</dt>
          <dd>{{ formatBytes(asset.size) }}</dd>
        </div>
        <div v-if="asset.width !== null && asset.height !== null">
          <dt>Dimensions</dt>
          <dd>{{ asset.width }} × {{ asset.height }}</dd>
        </div>
        <div>
          <dt>Alt</dt>
          <dd v-if="asset.alt !== null && asset.alt !== ''">{{ asset.alt }}</dd>
          <dd v-else-if="asset.alt === ''" class="asset-detail-muted">(decorative)</dd>
          <dd v-else class="asset-detail-muted">(not set)</dd>
        </div>
        <div>
          <dt>Uploaded</dt>
          <dd>{{ formatDate(asset.uploadedAt) }}</dd>
        </div>
      </dl>
      <div class="asset-detail-actions">
        <Button
          label="Delete"
          severity="danger"
          text
          size="small"
          data-testid="asset-detail-delete"
          @click="onDelete" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.asset-detail {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.asset-detail-empty {
  color: var(--p-text-muted-color);
  text-align: center;
  padding: 2rem 1rem;
}

.asset-detail-body {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.asset-detail-preview {
  aspect-ratio: 1 / 1;
  background: var(--p-content-hover-background);
  border-radius: 8px;
  overflow: hidden;
}

.asset-detail-preview img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.asset-detail-name {
  font-size: 1rem;
  margin: 0;
  word-break: break-word;
}

.asset-detail-fields {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  font-size: 0.875rem;
}

.asset-detail-fields div {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
}

.asset-detail-fields dt {
  color: var(--p-text-muted-color);
  flex-shrink: 0;
}

.asset-detail-fields dd {
  margin: 0;
  text-align: end;
  word-break: break-word;
}

.asset-detail-muted {
  color: var(--p-text-muted-color);
}

.asset-detail-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 0.5rem;
  border-top: 1px solid var(--p-content-border-color);
  padding-top: 0.75rem;
}
</style>
