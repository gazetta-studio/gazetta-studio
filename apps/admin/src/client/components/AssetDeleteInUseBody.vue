<script setup lang="ts">
/**
 * "Cannot delete — still in use" body for the delete-confirm dialog.
 *
 * Pure presentation. Receives the asset name + usage list, renders the
 * refuse-with-refs view. This component is the growth point when
 * replace-and-delete, clickable navigation, or locale coverage badges
 * land — none of those touch the shell or the other body components.
 */
import type { AssetRef } from '../api/assets.js'

defineProps<{
  assetName: string
  refs: readonly AssetRef[]
}>()
</script>

<template>
  <p>
    <strong>{{ assetName }}</strong> is still referenced by
    {{ refs.length }} item{{ refs.length === 1 ? '' : 's' }}. Remove the references before deleting.
  </p>
  <ul class="asset-delete-refs" data-testid="asset-delete-refs">
    <li v-for="ref in refs" :key="`${ref.path}::${ref.componentPath ?? ''}`">
      <span class="asset-delete-ref-source">{{ ref.source }}</span>
      <span class="asset-delete-ref-path">{{ ref.path }}</span>
      <span v-if="ref.componentPath" class="asset-delete-ref-component">@ {{ ref.componentPath }}</span>
    </li>
  </ul>
</template>

<style scoped>
.asset-delete-refs {
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 12rem;
  overflow-y: auto;
  border: 1px solid var(--p-content-border-color);
  border-radius: 6px;
}

.asset-delete-refs li {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
  padding: 0.4rem 0.6rem;
  font-size: 0.8125rem;
  border-bottom: 1px solid var(--p-content-border-color);
}

.asset-delete-refs li:last-child {
  border-bottom: none;
}

.asset-delete-ref-source {
  font-family: var(--p-font-family-monospace, monospace);
  color: var(--p-text-muted-color);
  text-transform: uppercase;
  font-size: 0.7rem;
}

.asset-delete-ref-path {
  flex: 1;
  word-break: break-all;
}

.asset-delete-ref-component {
  color: var(--p-text-muted-color);
  font-family: var(--p-font-family-monospace, monospace);
  font-size: 0.75rem;
}
</style>
