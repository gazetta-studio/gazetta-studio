<script setup lang="ts">
import { ref, onMounted } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Listbox from 'primevue/listbox'
import { useFragmentsApi, useTemplatesApi } from '../composables/api.js'
import { useSiteStore } from '../stores/site.js'
import { ArchivedNameConflictError, type ArchivedNameConflictDetails } from '../api/client.js'
import ArchivedNameConflictPrompt from './ArchivedNameConflictPrompt.vue'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const site = useSiteStore()
const fragmentsApi = useFragmentsApi()
const templatesApi = useTemplatesApi()
const templates = ref<Array<{ name: string }>>([])
const selectedTemplate = ref<string | null>(null)
const fragmentName = ref('')
const creating = ref(false)
const error = ref<string | null>(null)

/** Same morph-in-place pattern as CreatePageDialog. */
const conflict = ref<ArchivedNameConflictDetails | null>(null)

onMounted(async () => {
  templates.value = await templatesApi.getTemplates()
})

function normalizedName(): string {
  return fragmentName.value.trim().toLowerCase().replace(/\s+/g, '-')
}

async function handleCreate() {
  if (!selectedTemplate.value || !fragmentName.value.trim()) return
  creating.value = true
  error.value = null
  try {
    await fragmentsApi.createFragment({ name: normalizedName(), template: selectedTemplate.value })
    await site.load()
    emit('close')
  } catch (err) {
    if (err instanceof ArchivedNameConflictError) {
      conflict.value = err.archive
    } else {
      error.value = (err as Error).message
    }
  } finally {
    creating.value = false
  }
}

async function handleResolve(mode: 'restore' | 'replace' | 'moveAside') {
  if (!selectedTemplate.value || !conflict.value) return
  creating.value = true
  error.value = null
  try {
    await fragmentsApi.createFragment(
      { name: normalizedName(), template: selectedTemplate.value },
      { onConflict: mode },
    )
    await site.load()
    emit('close')
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    creating.value = false
  }
}

function handleConflictCancel() {
  conflict.value = null
  error.value = null
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
        <label>Fragment name</label>
        <InputText v-model="fragmentName" placeholder="e.g. sidebar, newsletter" class="create-input" />
      </div>

      <div class="create-field">
        <label>Template</label>
        <Listbox v-model="selectedTemplate" :options="templates" optionLabel="name" optionValue="name"
          class="create-list" :style="{ maxHeight: '200px' }" />
      </div>

      <p v-if="error" class="create-error">{{ error }}</p>
    </div>

    <template v-if="!conflict" #footer>
      <Button label="Cancel" severity="secondary" text @click="emit('close')" />
      <Button label="Create" icon="pi pi-plus" :loading="creating"
        :disabled="!selectedTemplate || !fragmentName.trim()" @click="handleCreate" />
    </template>
  </Dialog>
</template>

<style scoped>
.create-content { display: flex; flex-direction: column; gap: 1rem; }
.create-field { display: flex; flex-direction: column; gap: 0.375rem; }
.create-field label { font-size: 0.75rem; text-transform: uppercase; color: #888; letter-spacing: 0.03em; }
.create-input { width: 100%; }
.create-list { width: 100%; }
.create-error { color: #f87171; font-size: 0.875rem; }
</style>
