<script setup lang="ts">
/**
 * "Replacement asset isn't compatible" body for the delete-confirm
 * dialog. Appears when the user picked a replacement whose kind or
 * MIME category differs from the asset being deleted
 * (e.g. swapping an image with a video, or an image with a PDF).
 *
 * Pure presentation. The store owns the state transition;
 * `dismissKindMismatch()` on the store returns to the in-use view so
 * the author can pick a different replacement.
 */
import type { KindMismatchDetail } from '../stores/assetsDelete.js'

defineProps<{
  assetName: string
  detail: KindMismatchDetail
}>()
</script>

<template>
  <p>
    <strong>{{ assetName }}</strong> can't be replaced with the chosen asset.
  </p>
  <p class="asset-delete-kind-detail" data-testid="asset-delete-kind-detail">
    {{ assetName }} is
    <strong>{{ detail.oldKind }} / {{ detail.oldMimeCategory }}</strong
    >. The replacement you picked is
    <strong>{{ detail.newKind }} / {{ detail.newMimeCategory }}</strong
    >. Pick a replacement of the same kind and category.
  </p>
</template>

<style scoped>
.asset-delete-kind-detail {
  color: var(--p-text-muted-color);
  font-size: 0.875rem;
}
</style>
