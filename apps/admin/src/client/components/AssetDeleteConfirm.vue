<script setup lang="ts">
/**
 * Asset delete confirmation modal. Driven entirely by the `assetsDelete`
 * store — the button lives in AssetDetail and calls `ask(name)` to open
 * this dialog.
 *
 * Three render modes keyed off `status`:
 * - confirming / deleting — "Delete asset?" with Cancel + Delete buttons.
 *   The Delete button shows a pending state while the request is in flight.
 * - in-use — "Cannot delete" with the usage list. Only Close button.
 * - error — generic failure message with Close.
 *
 * Successful delete triggers `assetsList.refresh()` so the grid updates,
 * and clears the selected asset (the one we just deleted doesn't exist
 * anymore). Side effects live here, not in the store — the store owns
 * modal state, the component owns the broader UI reaction.
 */
import { computed } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import { useAssetsDeleteStore } from '../stores/assetsDelete.js'
import { useAssetsListStore } from '../stores/assetsList.js'
import { useAssetsSelectionStore } from '../stores/assetsSelection.js'

const del = useAssetsDeleteStore()
const list = useAssetsListStore()
const selection = useAssetsSelectionStore()

// Whether any dialog variant should be visible.
const visible = computed({
  get: () => del.status !== 'idle',
  set: (v: boolean) => {
    if (!v) del.close()
  },
})

const isDeleting = computed(() => del.status === 'deleting')
const isInUse = computed(() => del.status === 'in-use')
const isError = computed(() => del.status === 'error')

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
    :header="isInUse ? 'Cannot delete asset' : isError ? 'Delete failed' : 'Delete asset?'"
    data-testid="asset-delete-confirm">
    <!-- Confirming / deleting: asking the user to confirm. -->
    <div v-if="!isInUse && !isError" class="asset-delete-body">
      <p>
        Delete <strong data-testid="asset-delete-name">{{ del.assetName }}</strong
        >? This cannot be undone.
      </p>
    </div>

    <!-- In use: server refused with a usage list. -->
    <div v-else-if="isInUse" class="asset-delete-body">
      <p>
        <strong>{{ del.assetName }}</strong> is still referenced by
        {{ del.refs.length }} item{{ del.refs.length === 1 ? '' : 's' }}. Remove the references before deleting.
      </p>
      <ul class="asset-delete-refs" data-testid="asset-delete-refs">
        <li v-for="ref in del.refs" :key="`${ref.path}::${ref.componentPath}`">
          <span class="asset-delete-ref-source">{{ ref.source }}</span>
          <span class="asset-delete-ref-path">{{ ref.path }}</span>
          <span v-if="ref.componentPath !== '<root>'" class="asset-delete-ref-component">@ {{ ref.componentPath }}</span>
        </li>
      </ul>
    </div>

    <!-- Generic error. -->
    <div v-else class="asset-delete-body">
      <p>{{ del.errorMessage }}</p>
    </div>

    <template #footer>
      <div class="asset-delete-footer">
        <template v-if="!isInUse && !isError">
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

.asset-delete-footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
</style>
