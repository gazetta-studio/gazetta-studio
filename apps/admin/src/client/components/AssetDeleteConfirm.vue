<script setup lang="ts">
/**
 * Asset delete confirmation — dialog shell.
 *
 * Single responsibility: render the body + footer matching the store's
 * `dialogVariant`, and wire buttons to store actions. Zero state-machine
 * logic in the view — the store exposes one discriminator, we switch.
 *
 * Status-driven composition (store.dialogVariant):
 *   - `'hidden'`  → dialog not shown
 *   - `'confirm'` → `AssetDeleteConfirmBody` + Cancel/Delete footer
 *   - `'in-use'`  → `AssetDeleteInUseBody`   + Close footer
 *   - `'error'`   → `AssetDeleteErrorBody`   + Close footer
 *
 * Side effects on successful delete (clear selection, refresh list) live
 * here because they're cross-cutting UI reactions, not state — the store
 * stays pure and testable on its own.
 */
import { computed } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import { useAssetsDeleteStore } from '../stores/assetsDelete.js'
import { useAssetsListStore } from '../stores/assetsList.js'
import { useAssetsSelectionStore } from '../stores/assetsSelection.js'
import AssetDeleteConfirmBody from './AssetDeleteConfirmBody.vue'
import AssetDeleteInUseBody from './AssetDeleteInUseBody.vue'
import AssetDeleteErrorBody from './AssetDeleteErrorBody.vue'

const del = useAssetsDeleteStore()
const list = useAssetsListStore()
const selection = useAssetsSelectionStore()

const visible = computed({
  get: () => del.dialogVariant !== 'hidden',
  set: (v: boolean) => {
    if (!v) del.close()
  },
})

const isDeleting = computed(() => del.status === 'deleting')

const header = computed(() => {
  switch (del.dialogVariant) {
    case 'in-use':
      return 'Cannot delete asset'
    case 'error':
      return 'Delete failed'
    default:
      return 'Delete asset?'
  }
})

async function onConfirm(): Promise<void> {
  const ok = await del.confirmDelete()
  if (ok) {
    selection.clear()
    await list.refresh()
  }
}

function onClose(): void {
  del.close()
}
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    :closable="!isDeleting"
    :style="{ width: '28rem' }"
    :header="header"
    data-testid="asset-delete-confirm">
    <div class="asset-delete-body">
      <AssetDeleteConfirmBody v-if="del.dialogVariant === 'confirm'" :asset-name="del.assetName ?? ''" />
      <AssetDeleteInUseBody
        v-else-if="del.dialogVariant === 'in-use'"
        :asset-name="del.assetName ?? ''"
        :refs="del.refs" />
      <AssetDeleteErrorBody v-else-if="del.dialogVariant === 'error'" :message="del.errorMessage" />
    </div>

    <template #footer>
      <div class="asset-delete-footer">
        <template v-if="del.dialogVariant === 'confirm'">
          <Button label="Cancel" text :disabled="isDeleting" data-testid="asset-delete-cancel" @click="onClose" />
          <Button
            :label="isDeleting ? 'Deleting…' : 'Delete'"
            severity="danger"
            :loading="isDeleting"
            :disabled="isDeleting"
            data-testid="asset-delete-confirm-button"
            @click="onConfirm" />
        </template>
        <template v-else>
          <Button label="Close" data-testid="asset-delete-close" @click="onClose" />
        </template>
      </div>
    </template>
  </Dialog>
</template>

<style scoped>
.asset-delete-body {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  font-size: 0.9rem;
}

.asset-delete-footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
</style>
