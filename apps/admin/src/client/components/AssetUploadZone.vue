<script setup lang="ts">
/**
 * Asset upload zone — drag-and-drop + file input. Emits nothing; enqueues
 * files directly into the upload store. On a successful upload the list
 * store is refreshed so the new asset appears in the grid.
 *
 * For v1, the name derives from the filename (extension stripped, slugified
 * lowercase). Authors can rename after upload in the wide rollout.
 * Alt text at upload is skipped for v1; authors edit alt from the detail
 * pane. Rationale: the slice validates the pipeline; the design-doc's
 * "prompt for alt at upload" UX lands with the wide rollout.
 */
import { ref, watch } from 'vue'
import { useAssetsUploadStore } from '../stores/assetsUpload.js'
import { useAssetsListStore } from '../stores/assetsList.js'

const uploads = useAssetsUploadStore()
const list = useAssetsListStore()

const fileInput = ref<HTMLInputElement | null>(null)
const isDragging = ref(false)

function openFilePicker(): void {
  fileInput.value?.click()
}

function onFilesPicked(event: Event): void {
  const input = event.target as HTMLInputElement
  enqueueFiles(input.files)
  // Reset the input so the same file can be re-picked
  input.value = ''
}

function onDrop(event: DragEvent): void {
  event.preventDefault()
  isDragging.value = false
  enqueueFiles(event.dataTransfer?.files ?? null)
}

function onDragOver(event: DragEvent): void {
  event.preventDefault()
  isDragging.value = true
}

function onDragLeave(): void {
  isDragging.value = false
}

function enqueueFiles(files: FileList | null): void {
  if (!files) return
  for (const file of Array.from(files)) {
    const name = deriveName(file.name)
    uploads.enqueue(file, name, null)
  }
}

/** Slugify a filename into an asset name (lowercase, dashes). */
function deriveName(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, '')
  return (
    stem
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'asset'
  )
}

// Refresh the list when any upload completes successfully. The watcher
// fires every time an entry transitions to 'success'; the list store
// dedupes concurrent refreshes itself.
watch(
  () =>
    uploads.uploads
      .filter(u => u.status === 'success')
      .map(u => u.id)
      .join(','),
  (current, previous) => {
    if (current !== previous && current.length > 0) {
      void list.refresh()
    }
  },
)
</script>

<template>
  <div
    :class="['upload-zone', { dragging: isDragging }]"
    data-testid="asset-upload-zone"
    @click="openFilePicker"
    @drop="onDrop"
    @dragover="onDragOver"
    @dragleave="onDragLeave">
    <i class="pi pi-upload" />
    <span>Drop files or click to upload</span>
    <input
      ref="fileInput"
      type="file"
      multiple
      accept="image/jpeg,image/png"
      data-testid="asset-upload-input"
      @change="onFilesPicked" />
  </div>

  <div v-if="uploads.uploads.length > 0" class="upload-list" data-testid="asset-upload-list">
    <div v-for="entry in uploads.uploads" :key="entry.id" class="upload-entry" :data-testid="`upload-${entry.id}`">
      <span class="upload-name">{{ entry.name }}</span>
      <span class="upload-status" :data-status="entry.status">
        <template v-if="entry.status === 'queued'">Queued</template>
        <template v-else-if="entry.status === 'uploading'">Uploading…</template>
        <template v-else-if="entry.status === 'success'">Done</template>
        <template v-else>
          <span class="upload-error">{{ entry.errorMessage ?? 'Failed' }}</span>
        </template>
      </span>
    </div>
  </div>
</template>

<style scoped>
.upload-zone {
  border: 2px dashed var(--p-content-border-color);
  border-radius: 8px;
  padding: 1.5rem;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  cursor: pointer;
  color: var(--p-text-muted-color);
  transition: border-color 120ms, background-color 120ms;
}

.upload-zone:hover,
.upload-zone.dragging {
  border-color: var(--p-primary-color);
  background: var(--p-content-hover-background);
}

.upload-zone input[type='file'] {
  display: none;
}

.upload-list {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.875rem;
}

.upload-entry {
  display: flex;
  justify-content: space-between;
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  background: var(--p-content-hover-background);
}

.upload-status[data-status='error'] {
  color: var(--p-red-500);
}

.upload-status[data-status='success'] {
  color: var(--p-green-500);
}
</style>
