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
import { updateAssetMetadata } from '../api/assets.js'
import { useAssetsUploadStore } from '../stores/assetsUpload.js'
import { useAssetsUploadPromptStore } from '../stores/assetsUploadPrompt.js'
import { useAssetsListStore } from '../stores/assetsList.js'
import { useLocaleStore } from '../stores/locale.js'

const uploads = useAssetsUploadStore()
const list = useAssetsListStore()
const promptStore = useAssetsUploadPromptStore()
const locale = useLocaleStore()

/**
 * Per-upload-entry alt state. Keyed by `entry.id` so multiple successful
 * uploads can hold independent in-flight alt values. The text input
 * commits on blur (PATCH the asset); the checkbox commits on change.
 *
 * Three-state alt is honored at commit time — empty string + decorative
 * checked → "" (decorative); empty string + unchecked → null (unset);
 * non-empty text + unchecked → meaningful description.
 */
const altText = ref<Map<string, string>>(new Map())
const altDecorative = ref<Map<string, boolean>>(new Map())

function altValueFor(id: string): string {
  return altText.value.get(id) ?? ''
}
function altDecorativeFor(id: string): boolean {
  return altDecorative.value.get(id) ?? false
}

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

/**
 * Persist alt for a successfully-uploaded entry. Called on blur of the
 * text input. Three-state semantics:
 *   - decorative checkbox checked → alt: '' (regardless of input value)
 *   - input non-empty             → alt: value (after trim)
 *   - input empty + not decorative → alt: null (still unset)
 *
 * On error the inline state retains the user's input so they can retry;
 * we surface the failure via a console warning for now (toast surface
 * is a follow-up).
 */
async function onAltBlur(event: Event, id: string, assetName: string): Promise<void> {
  const input = event.target as HTMLInputElement
  const raw = input.value.trim()
  altText.value.set(id, raw)
  if (altDecorativeFor(id)) return // decorative wins; the blur is a no-op
  await commitAlt(assetName, raw === '' ? null : raw)
}

async function onDecorativeChange(event: Event, id: string, assetName: string): Promise<void> {
  const checked = (event.target as HTMLInputElement).checked
  altDecorative.value.set(id, checked)
  if (checked) {
    await commitAlt(assetName, '')
  } else {
    // Toggling off reverts to whatever the input currently holds. If
    // empty, alt becomes null (unset); if filled, becomes the text.
    const text = altValueFor(id)
    await commitAlt(assetName, text === '' ? null : text)
  }
}

async function commitAlt(assetName: string, alt: string | null): Promise<void> {
  try {
    await updateAssetMetadata(assetName, { alt })
    await list.refresh()
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`Failed to update alt for ${assetName}:`, err)
  }
}
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
      <div class="upload-entry-head">
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
      <!--
        Inline alt entry — only for successful image uploads of the
        default asset (locale-bytes overrides inherit alt from the
        default; per-locale alt would live on the locale manifest, a
        future surface). Non-blocking: author can fill alt now or close
        the library and resolve later via the detail-pane editor.
      -->
      <div
        v-if="
          entry.status === 'success' && entry.kind === 'default' && (entry.file.type ?? '').startsWith('image/')
        "
        class="upload-entry-alt"
        :data-testid="`upload-${entry.id}-alt`">
        <input
          type="text"
          placeholder="Alt text (describe the image for accessibility)"
          :value="altValueFor(entry.id)"
          :disabled="altDecorativeFor(entry.id)"
          :data-testid="`upload-${entry.id}-alt-input`"
          @blur="onAltBlur($event, entry.id, entry.name)" />
        <label class="upload-entry-decorative">
          <input
            type="checkbox"
            :checked="altDecorativeFor(entry.id)"
            :data-testid="`upload-${entry.id}-alt-decorative`"
            @change="onDecorativeChange($event, entry.id, entry.name)" />
          Decorative
        </label>
      </div>
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
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.375rem 0.5rem;
  border-radius: 4px;
  background: var(--p-content-hover-background);
}

.upload-entry-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
}

.upload-status[data-status='error'] {
  color: var(--p-red-500);
}

.upload-status[data-status='success'] {
  color: var(--p-green-500);
}

.upload-entry-alt {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.upload-entry-alt input[type='text'] {
  flex: 1;
  font: inherit;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--p-form-field-border-color);
  border-radius: 4px;
  background: var(--p-form-field-background);
  color: var(--p-text-color);
}

.upload-entry-alt input[type='text']:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.upload-entry-decorative {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
  white-space: nowrap;
}
</style>
