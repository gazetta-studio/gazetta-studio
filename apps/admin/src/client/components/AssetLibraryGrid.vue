<script setup lang="ts">
/**
 * Asset library grid — renders every asset known to the list store as a
 * clickable card. Pure presentation: reads from `assetsList`, writes
 * selection via `assetsSelection`. No fetching, no state beyond what the
 * stores expose.
 *
 * Image thumbnails use the full-size bytes for v1 (CSS-sized down).
 * Variant thumbnails arrive with the variant-generation work in a later
 * step; the grid reads the same URL either way.
 */
import { computed } from 'vue'
import { useAssetsListStore } from '../stores/assetsList.js'
import { useAssetsSelectionStore } from '../stores/assetsSelection.js'
import { ASSETS_URL_PREFIX, buildAssetUrl, extFromMime } from '../utils/assetUrl.js'

const list = useAssetsListStore()
const selection = useAssetsSelectionStore()

const cards = computed(() =>
  list.assets.map(a => ({
    ...a,
    thumbUrl: thumbnailUrl(a.name, a.hash, a.mime),
  })),
)

function thumbnailUrl(name: string, hash: string, mime: string): string | null {
  const ext = extFromMime(mime)
  if (!ext) return null
  return buildAssetUrl({ name, hash, ext })
}

function onCardClick(name: string): void {
  selection.select(name)
}
</script>

<template>
  <div class="asset-grid-wrap" data-testid="asset-grid">
    <div v-if="list.loading && !list.loaded" class="asset-grid-state" data-testid="asset-grid-loading">
      Loading…
    </div>
    <div v-else-if="list.error" class="asset-grid-state asset-grid-error" data-testid="asset-grid-error">
      {{ list.error }}
    </div>
    <div v-else-if="cards.length === 0" class="asset-grid-state" data-testid="asset-grid-empty">
      No assets yet. Drop files into the upload zone above to get started.
    </div>
    <div v-else class="asset-grid">
      <button
        v-for="card in cards"
        :key="card.name"
        :class="['asset-card', { selected: selection.isSelected(card.name) }]"
        :data-testid="`asset-card-${card.name}`"
        @click="onCardClick(card.name)">
        <div class="asset-card-thumb">
          <img v-if="card.thumbUrl" :src="card.thumbUrl" :alt="card.alt ?? ''" />
          <i v-else class="pi pi-file" />
        </div>
        <div class="asset-card-name">{{ card.name }}</div>
      </button>
    </div>
  </div>
</template>

<style scoped>
.asset-grid-wrap {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.asset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 0.75rem;
  padding: 0.25rem;
}

.asset-grid-state {
  padding: 2rem;
  text-align: center;
  color: var(--p-text-muted-color);
}

.asset-grid-error {
  color: var(--p-red-500);
}

.asset-card {
  border: 2px solid transparent;
  border-radius: 8px;
  padding: 0;
  background: var(--p-content-background);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  overflow: hidden;
  font: inherit;
  color: inherit;
  text-align: left;
}

.asset-card:hover {
  border-color: var(--p-primary-color);
}

.asset-card.selected {
  border-color: var(--p-primary-color);
  box-shadow: 0 0 0 2px var(--p-primary-color);
}

.asset-card-thumb {
  aspect-ratio: 1 / 1;
  background: var(--p-content-hover-background);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.asset-card-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.asset-card-thumb i {
  font-size: 2rem;
  color: var(--p-text-muted-color);
}

.asset-card-name {
  padding: 0.5rem 0.75rem;
  font-size: 0.875rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
