<script setup lang="ts">
import { Plus } from '@lucide/vue'
import { ref, onMounted } from 'vue'
import Dialog from './ui/Dialog.vue'
import Button from './ui/Button.vue'
import TextInput from './ui/TextInput.vue'
import Listbox from './ui/Listbox.vue'
import { useTemplatesApi } from '../composables/api.js'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'add', name: string, template: string): void }>()
const templatesApi = useTemplatesApi()
const templates = ref<Array<{ name: string }>>([])
const selectedTemplate = ref<string | null>(null)
const componentName = ref('')
const creating = ref(false)
const error = ref<string | null>(null)

onMounted(async () => {
  templates.value = await templatesApi.getTemplates()
})

async function handleCreate() {
  if (!selectedTemplate.value || !componentName.value.trim()) return
  creating.value = true
  error.value = null
  try {
    const name = componentName.value.trim().toLowerCase().replace(/\s+/g, '-')
    emit('add', name, selectedTemplate.value)
    emit('close')
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <Dialog :visible="props.visible" @update:visible="emit('close')" modal header="Add Component" :style="{ width: '24rem' }">
    <div class="add-content">
      <div class="add-field">
        <label for="add-component-name">Name</label>
        <TextInput id="add-component-name" v-model="componentName" placeholder="e.g. hero, sidebar, cta" class="add-input" data-testid="add-component-name" />
      </div>

      <div class="add-field">
        <label id="add-component-template-label">Template</label>
        <Listbox v-model="selectedTemplate" aria-labelledby="add-component-template-label" :options="templates" optionLabel="name" optionValue="name"
          class="add-list" :style="{ maxHeight: '200px' }" />
      </div>

      <p v-if="error" class="add-error">{{ error }}</p>
    </div>

    <template #footer>
      <Button label="Cancel" severity="secondary" text @click="emit('close')" data-testid="add-component-cancel" />
      <Button label="Add" :icon="Plus" :loading="creating"
        :disabled="!selectedTemplate || !componentName.trim()" @click="handleCreate" data-testid="add-component-submit" />
    </template>
  </Dialog>
</template>

<style scoped>
.add-content { display: flex; flex-direction: column; gap: 1rem; }
.add-field { display: flex; flex-direction: column; gap: 0.375rem; }
.add-field label { font-size: 0.75rem; text-transform: uppercase; color: var(--color-muted); letter-spacing: 0.03em; }
.add-input { width: 100%; }
.add-list { width: 100%; }
.add-error { color: var(--color-danger-fg); font-size: 0.875rem; }
</style>
