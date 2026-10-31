<script setup lang="ts">
import { Plus } from '@lucide/vue'
import { ref, onMounted } from 'vue'
import Dialog from './ui/Dialog.vue'
import Button from './ui/Button.vue'
import TextInput from './ui/TextInput.vue'
import Listbox from './ui/Listbox.vue'
import { useFragmentsApi, useTemplatesApi } from '../composables/api.js'
import { useSiteStore } from '../stores/site.js'
import { useArchivedConflict } from '../composables/useArchivedConflict.js'
import ArchivedNameConflictPrompt from './ArchivedNameConflictPrompt.vue'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const site = useSiteStore()
const fragmentsApi = useFragmentsApi()
const templatesApi = useTemplatesApi()
const templates = ref<Array<{ name: string }>>([])
const selectedTemplate = ref<string | null>(null)
const fragmentName = ref('')

onMounted(async () => {
  templates.value = await templatesApi.getTemplates()
})

function normalizedName(): string {
  return fragmentName.value.trim().toLowerCase().replace(/\s+/g, '-')
}

/** Shared morph-in-place wiring per useArchivedConflict (#486). */
const {
  conflict,
  error,
  busy: creating,
  run,
  handleResolve,
  handleConflictCancel,
} = useArchivedConflict({
  attempt: opts =>
    fragmentsApi.createFragment({ name: normalizedName(), template: selectedTemplate.value as string }, opts),
  onSuccess: async () => {
    await site.load()
    emit('close')
  },
})

async function handleCreate() {
  if (!selectedTemplate.value || !fragmentName.value.trim()) return
  await run()
}
</script>

<template>
  <Dialog :visible="props.visible" @update:visible="emit('close')" modal
    :header="conflict ? 'Name conflicts with an archive' : 'New Fragment'"
    :style="{ width: conflict ? '32rem' : '24rem' }">
    <ArchivedNameConflictPrompt
      v-if="conflict"
      :archive="conflict"
      :busy="creating"
      @resolve="handleResolve"
      @cancel="handleConflictCancel" />

    <div v-else class="create-content">
      <div class="create-field">
        <label for="create-fragment-name">Fragment name</label>
        <TextInput id="create-fragment-name" v-model="fragmentName" placeholder="e.g. sidebar, newsletter" class="create-input" />
      </div>

      <div class="create-field">
        <label id="create-fragment-template-label">Template</label>
        <Listbox v-model="selectedTemplate" aria-labelledby="create-fragment-template-label" :options="templates" optionLabel="name" optionValue="name"
          class="create-list" :style="{ maxHeight: '200px' }" />
      </div>

      <p v-if="error" class="create-error">{{ error }}</p>
    </div>

    <template v-if="!conflict" #footer>
      <Button label="Cancel" severity="secondary" text @click="emit('close')" />
      <Button label="Create" :icon="Plus" :loading="creating"
        :disabled="!selectedTemplate || !fragmentName.trim()" @click="handleCreate" />
    </template>
  </Dialog>
</template>

<style scoped>
.create-content { display: flex; flex-direction: column; gap: 1rem; }
.create-field { display: flex; flex-direction: column; gap: 0.375rem; }
.create-field label { font-size: 0.75rem; text-transform: uppercase; color: var(--color-muted); letter-spacing: 0.03em; }
.create-input { width: 100%; }
.create-list { width: 100%; }
.create-error { color: var(--color-danger-fg); font-size: 0.875rem; }
</style>
