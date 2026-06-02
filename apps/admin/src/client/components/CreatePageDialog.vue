<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Listbox from 'primevue/listbox'
import { usePagesApi, useTemplatesApi } from '../composables/api.js'
import { useSiteStore } from '../stores/site.js'
import { useArchivedConflict } from '../composables/useArchivedConflict.js'
import ArchivedNameConflictPrompt from './ArchivedNameConflictPrompt.vue'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const site = useSiteStore()
const pagesApi = usePagesApi()
const templatesApi = useTemplatesApi()
const templates = ref<Array<{ name: string }>>([])
const selectedTemplate = ref<string | null>(null)
const pageName = ref('')

const derivedRoute = computed(() => {
  const name = pageName.value.trim().toLowerCase().replace(/\s+/g, '-')
  if (!name || name === 'home') return '/'
  return `/${name}`
})

onMounted(async () => {
  templates.value = await templatesApi.getTemplates()
})

function normalizedName(): string {
  return pageName.value.trim().toLowerCase().replace(/\s+/g, '-').replace(/\/+/g, '/')
}

/**
 * Archived-name-conflict morph wiring per design-soft-delete.md Q5 I3.
 * Extracted to `useArchivedConflict` at the rule-15 3-caller threshold
 * (#486); shared with CreateFragmentDialog + CreateRedirectDialog. The
 * composable owns the `conflict` ref, the try/catch that routes
 * `ArchivedNameConflictError` into the morph prompt vs. surfacing other
 * messages as `error`, and the resolution-replay loop.
 */
const {
  conflict,
  error,
  busy: creating,
  run,
  handleResolve,
  handleConflictCancel,
} = useArchivedConflict({
  attempt: opts => pagesApi.createPage({ name: normalizedName(), template: selectedTemplate.value as string }, opts),
  onSuccess: async () => {
    await site.load()
    emit('close')
  },
})

async function handleCreate() {
  if (!selectedTemplate.value || !pageName.value.trim()) return
  await run()
}
</script>

<template>
  <Dialog :visible="props.visible" @update:visible="emit('close')" modal
    :header="conflict ? 'Name conflicts with an archive' : 'New Page'"
    :style="{ width: conflict ? '32rem' : '24rem' }">
    <!--
      Morph in place: when conflict is null, render the create form;
      when ARCHIVED_NAME_CONFLICT surfaces, render the resolution
      prompt. Per design-soft-delete.md Q5 I3 lock + Cut 11 grilling
      Q1 (A1+A3 absorbed): one dialog, two body modes.
    -->
    <ArchivedNameConflictPrompt
      v-if="conflict"
      :archive="conflict"
      :busy="creating"
      @resolve="handleResolve"
      @cancel="handleConflictCancel" />

    <div v-else class="create-content">
      <div class="create-field">
        <label>Page name</label>
        <InputText v-model="pageName" placeholder="e.g. contact or blog/my-post" class="create-input" />
        <span v-if="pageName.trim()" class="create-hint">Route: {{ derivedRoute }}</span>
      </div>

      <div class="create-field">
        <label>Page template</label>
        <Listbox v-model="selectedTemplate" :options="templates" optionLabel="name" optionValue="name"
          class="create-list" :style="{ maxHeight: '200px' }" />
      </div>

      <p v-if="error" class="create-error">{{ error }}</p>
    </div>

    <template v-if="!conflict" #footer>
      <Button label="Cancel" severity="secondary" text @click="emit('close')" />
      <Button label="Create" icon="pi pi-plus" :loading="creating"
        :disabled="!selectedTemplate || !pageName.trim()" @click="handleCreate" />
    </template>
  </Dialog>
</template>

<style scoped>
.create-content { display: flex; flex-direction: column; gap: 1rem; }
.create-field { display: flex; flex-direction: column; gap: 0.375rem; }
.create-field label { font-size: 0.75rem; text-transform: uppercase; color: #888; letter-spacing: 0.03em; }
.create-input { width: 100%; }
.create-list { width: 100%; }
.create-hint { font-size: 0.75rem; color: #666; }
.create-error { color: #f87171; font-size: 0.875rem; }
</style>
