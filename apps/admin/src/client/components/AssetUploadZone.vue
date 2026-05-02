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
import { useAssetsUploadPromptStore } from '../stores/assetsUploadPrompt.js'
import { useAssetsListStore } from '../stores/assetsList.js'
import { useLocaleStore } from '../stores/locale.js'

const uploads = useAssetsUploadStore()
const list = useAssetsListStore()
const promptStore = useAssetsUploadPromptStore()
const locale = useLocaleStore()

const fileInput = ref<HTMLInputElement | null>(null)
const isDragging = ref(false)

function openFilePicker(): void {
  fileInput.value?.click()
}

function onFilesPicked(event: Event): void {
  const input = event.target as HTMLInputElement
  void enqueueFiles(input.files)
  // Reset the input so the same file can be re-picked
  input.value = ''
}

function onDrop(event: DragEvent): void {
  event.preventDefault()
  isDragging.value = false
  void enqueueFiles(event.dataTransfer?.files ?? null)
}

function onDragOver(event: DragEvent): void {
  event.preventDefault()
  isDragging.value = true
}

function onDragLeave(): void {
  isDragging.value = false
}

async function enqueueFiles(files: FileList | null): Promise<void> {
  if (!files) return
  for (const file of Array.from(files)) {
    const name = deriveName(file.name)
    await routeUpload(file, name)
  }
}

/**
 * Decide whether this upload goes to the default asset or to a locale
 * override. Three cases:
 *
 *   1. Active locale = default (or i18n disabled) → default upload (unchanged)
 *   2. Active locale != default + no name collision → default upload (uploading
 *      a brand-new asset always creates the default; the design-doc rule is
 *      "first upload establishes the asset's identity; locale overrides come
 *      after")
 *   3. Active locale != default + collision → prompt the user
 */
async function routeUpload(file: File, name: string): Promise<void> {
  const activeLocale = locale.activeLocale
  const defaultLocale = locale.defaultLocale
  const overrideLocale = locale.effectiveLocale

  // Case 1 + 2: no override locale OR no collision → default upload.
  if (overrideLocale === null) {
    uploads.enqueue(file, name, null)
    return
  }
  const collision = list.assets.some(a => a.name === name)
  if (!collision) {
    uploads.enqueue(file, name, null)
    return
  }

  // Case 3: ask the user.
  const choice = await promptStore.prompt({
    file,
    name,
    locale: overrideLocale,
    defaultLocaleLabel: defaultLocale ?? undefined,
    activeLocaleLabel: activeLocale ?? overrideLocale,
  })
  if (choice === 'cancel') return
  if (choice === 'replace-default') {
    uploads.enqueue(file, name, null)
    return
  }
  uploads.enqueueLocaleBytes(file, name, { locale: overrideLocale })
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
