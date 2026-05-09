<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Listbox from 'primevue/listbox'
import { usePagesApi, useTemplatesApi } from '../composables/api.js'
import { useSiteStore } from '../stores/site.js'
import { ArchivedNameConflictError, type ArchivedNameConflictDetails } from '../api/client.js'
import ArchivedNameConflictPrompt from './ArchivedNameConflictPrompt.vue'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const site = useSiteStore()
const pagesApi = usePagesApi()
const templatesApi = useTemplatesApi()
const templates = ref<Array<{ name: string }>>([])
const selectedTemplate = ref<string | null>(null)
const pageName = ref('')
const creating = ref(false)
const error = ref<string | null>(null)

/**
 * Archived-name-conflict prompt state per design-soft-delete.md Q5
 * I3. When the create POST returns 409 ARCHIVED_NAME_CONFLICT, the
 * dialog body morphs in place to show the three-option prompt; the
 * outer Dialog chrome stays.
 */
const conflict = ref<ArchivedNameConflictDetails | null>(null)

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

async function handleCreate() {
  if (!selectedTemplate.value || !pageName.value.trim()) return
  creating.value = true
  error.value = null
  try {
    await pagesApi.createPage({ name: normalizedName(), template: selectedTemplate.value })
    await site.load()
    emit('close')
  } catch (err) {
    if (err instanceof ArchivedNameConflictError) {
      // Morph the dialog body into the conflict prompt; keep the
      // dialog chrome open. The author resolves via Restore /
      // Replace / Move-aside; the resolution call retries the same
      // create POST with `?onConflict=`.
      conflict.value = err.archive
    } else {
      error.value = (err as Error).message
    }
  } finally {
    creating.value = false
  }
}

/**
 * Author chose Restore / Replace / Move-aside. Re-issue the create
 * POST with the chosen mode; on success close the dialog and reload
 * the site listing. On error, surface the message in place; the
 * conflict prompt stays so the author can pick differently.
 */
async function handleResolve(mode: 'restore' | 'replace' | 'moveAside') {
  if (!selectedTemplate.value || !conflict.value) return
  creating.value = true
  error.value = null
  try {
    await pagesApi.createPage({ name: normalizedName(), template: selectedTemplate.value }, { onConflict: mode })
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
