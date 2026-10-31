<script setup lang="ts">
import { Check } from '@lucide/vue'
import Dialog from './ui/Dialog.vue'
import Button from './ui/Button.vue'
import { useUnsavedGuardStore } from '../stores/unsavedGuard.js'
import { useSelectionStore } from '../stores/selection.js'

const guard = useUnsavedGuardStore()
const selection = useSelectionStore()

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    guard.respond('cancel')
  }
}
</script>

<template>
  <Dialog :visible="guard.visible" modal header="Unsaved Changes" :closable="false"
    :style="{ width: '26rem' }" :pt="{ mask: { style: 'backdrop-filter: blur(2px)' } }"
    @keydown="onKeydown">
    <p class="unsaved-message">
      You have unsaved changes on <strong>{{ selection.name }}</strong>.
    </p>
    <template #footer>
      <div class="unsaved-actions">
        <Button label="Don't Save" severity="danger" text @click="guard.respond('discard')" />
        <Button label="Cancel" severity="secondary" text @click="guard.respond('cancel')" />
        <Button label="Save" :icon="Check" autofocus @click="guard.respond('save')" />
      </div>
    </template>
  </Dialog>
</template>

<style scoped>
.unsaved-message { font-size: 0.875rem; color: var(--color-fg); line-height: 1.5; margin: 0; }
.unsaved-actions { display: flex; gap: 0.5rem; justify-content: flex-end; width: 100%; }
</style>
