<script setup lang="ts">
/**
 * Asset detail pane — shows metadata for the selected asset from the grid.
 * No edit affordances in v1; authors can edit in a later step once the
 * persistence path is in place (PATCH /api/assets/:name).
 *
 * Reads from `assetsSelection` + `assetsList`. If the selection points to
 * an asset not in the list (stale after a refresh), shows an empty state.
 */
import { computed, ref } from 'vue'
import Button from 'primevue/button'
import { formatBytes } from 'gazetta/format'
import { suggestAlt, updateAssetMetadata, type SuggestAltResult } from '../api/assets.js'
import { useActiveTargetStore } from '../stores/activeTarget.js'
import { useAssetsListStore } from '../stores/assetsList.js'
import { useAssetsSelectionStore } from '../stores/assetsSelection.js'
import { useAssetsDeleteStore } from '../stores/assetsDelete.js'
import { useLocaleStore } from '../stores/locale.js'
import { buildAssetUrl, extFromMime } from '../utils/assetUrl.js'
import AssetAltEditor from './AssetAltEditor.vue'
import AssetDetailLocaleSection from './AssetDetailLocaleSection.vue'
import AssetFocalPointEditor from './AssetFocalPointEditor.vue'

const list = useAssetsListStore()
const selection = useAssetsSelectionStore()
const del = useAssetsDeleteStore()
const activeTarget = useActiveTargetStore()
const locale = useLocaleStore()

function onDelete(): void {
  if (!asset.value) return
  del.ask(asset.value.name)
}

/**
 * Commit alt change from the editor. Non-blocking: failures log to
 * console and the list refresh skips. Future: surface via toast.
 */
async function onAltUpdate(value: string | null): Promise<void> {
  if (!asset.value) return
  const name = asset.value.name
  try {
    await updateAssetMetadata(name, { alt: value })
    await list.refresh()
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`Failed to update alt for ${name}:`, err)
  }
}

/**
 * Commit a focal point change (or reset to null). Same non-blocking
 * pattern as alt — failures log to console; toast surface is a follow-up.
 */
async function onFocalPointUpdate(value: { x: number; y: number } | null): Promise<void> {
  if (!asset.value) return
  const name = asset.value.name
  try {
    await updateAssetMetadata(name, { focalPoint: value })
    await list.refresh()
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`Failed to update focal point for ${name}:`, err)
  }
}

const isImage = computed(() => asset.value?.mime?.startsWith('image/') ?? false)

/**
 * AI alt-text capability for the active target. The detail-pane
 * "✨ Suggest" button renders only when the adapter is configured
 * (independent of the `auto` flag — auto controls upload-time
 * pre-fill, not on-demand button visibility).
 */
const aiAvailable = computed(() => activeTarget.activeTarget?.altText.available ?? false)

/** True while a suggestion is in-flight; gates the "Generating…" indicator. */
const aiPending = ref(false)
/** Refusal reason from the last suggest call. Null when not refused or unset. */
const aiRefusalReason = ref<string | null>(null)

/**
 * Trigger an AI alt-text suggestion for the currently-selected asset.
 * On success, commits the suggestion to the manifest via the existing
 * `onAltUpdate` flow — same path as if the author had typed manually.
 * Refusals surface inline; transport errors log to console (toast
 * surface is a follow-up).
 */
async function onSuggestAlt(): Promise<void> {
  if (!asset.value) return
  const name = asset.value.name
  aiPending.value = true
  aiRefusalReason.value = null
  let result: SuggestAltResult | null = null
  try {
    result = await suggestAlt(name, locale.activeLocale ?? undefined)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`AI alt suggestion failed for ${name}:`, err)
    return
  } finally {
    aiPending.value = false
  }
  if (!result) return
  if (result.refused) {
    aiRefusalReason.value = result.refusalReason ?? 'Model declined'
    return
  }
  await onAltUpdate(result.text)
}

const asset = computed(() => {
  if (!selection.selectedName) return null
  return list.assets.find(a => a.name === selection.selectedName) ?? null
})

const previewUrl = computed(() => {
  if (!asset.value) return null
  const ext = extFromMime(asset.value.mime)
  if (!ext) return null
  return buildAssetUrl({ name: asset.value.name, hash: asset.value.hash, ext })
})

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}
</script>

<template>
  <div class="asset-detail" data-testid="asset-detail">
    <div v-if="!asset" class="asset-detail-empty" data-testid="asset-detail-empty">
      Select an asset to view details.
    </div>
    <div v-else class="asset-detail-body">
      <div v-if="previewUrl" class="asset-detail-preview">
        <img :src="previewUrl" :alt="asset.alt ?? ''" />
      </div>
      <h2 class="asset-detail-name" data-testid="asset-detail-name">{{ asset.name }}</h2>
      <dl class="asset-detail-fields">
        <div>
          <dt>Kind</dt>
          <dd>{{ asset.kind }}</dd>
        </div>
        <div>
          <dt>Type</dt>
          <dd>{{ asset.mime }}</dd>
        </div>
        <div>
          <dt>Size</dt>
          <dd>{{ formatBytes(asset.size) }}</dd>
        </div>
        <div v-if="asset.width !== null && asset.height !== null">
          <dt>Dimensions</dt>
          <dd>{{ asset.width }} × {{ asset.height }}</dd>
        </div>
        <div v-if="isImage" class="asset-detail-alt">
          <dt>Alt</dt>
          <dd>
            <AssetAltEditor :model-value="asset.alt" @update:model-value="onAltUpdate" />
            <div v-if="aiAvailable" class="asset-detail-alt-ai">
              <Button
                label="✨ Suggest"
                text
                size="small"
                :loading="aiPending"
                :disabled="aiPending"
                data-testid="asset-detail-suggest-alt"
                @click="onSuggestAlt" />
              <p
                v-if="aiRefusalReason"
                class="asset-detail-alt-refusal"
                data-testid="asset-detail-ai-refusal">
                ✨ AI declined: {{ aiRefusalReason }}
              </p>
            </div>
          </dd>
        </div>
        <div v-if="isImage && previewUrl" class="asset-detail-focal">
          <dt>Focal point</dt>
          <dd>
            <AssetFocalPointEditor
              :model-value="asset.focalPoint ?? null"
              :image-url="previewUrl"
              :alt="asset.alt"
              @update:model-value="onFocalPointUpdate" />
          </dd>
        </div>
        <div v-else>
          <dt>Alt</dt>
          <dd v-if="asset.alt !== null && asset.alt !== ''">{{ asset.alt }}</dd>
          <dd v-else-if="asset.alt === ''" class="asset-detail-muted">(decorative)</dd>
          <dd v-else class="asset-detail-muted">(not set)</dd>
        </div>
        <div>
          <dt>Uploaded</dt>
          <dd>{{ formatDate(asset.uploadedAt) }}</dd>
        </div>
      </dl>
      <AssetDetailLocaleSection :asset="asset" />
      <div class="asset-detail-actions">
        <Button
          label="Delete"
          severity="danger"
          text
          size="small"
          data-testid="asset-detail-delete"
          @click="onDelete" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.asset-detail {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.asset-detail-empty {
  color: var(--p-text-muted-color);
  text-align: center;
  padding: 2rem 1rem;
}

.asset-detail-body {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.asset-detail-preview {
  aspect-ratio: 1 / 1;
  background: var(--p-content-hover-background);
  border-radius: 8px;
  overflow: hidden;
}

.asset-detail-preview img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.asset-detail-name {
  font-size: 1rem;
  margin: 0;
  word-break: break-word;
}

.asset-detail-fields {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  font-size: 0.875rem;
}

.asset-detail-fields div {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
}

.asset-detail-fields dt {
  color: var(--p-text-muted-color);
  flex-shrink: 0;
}

.asset-detail-fields dd {
  margin: 0;
  text-align: end;
  word-break: break-word;
}

.asset-detail-muted {
  color: var(--p-text-muted-color);
}

.asset-detail-alt,
.asset-detail-focal {
  /* Override the default row layout — alt + focal editors each need to
     stack dt above dd because the editor itself is a column of inputs,
     not a single inline value. */
  flex-direction: column !important;
  align-items: stretch;
  gap: 0.25rem !important;
}

.asset-detail-alt dd,
.asset-detail-focal dd {
  text-align: start;
}

.asset-detail-alt-ai {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin-top: 0.375rem;
}

.asset-detail-alt-refusal {
  margin: 0;
  font-size: 0.75rem;
  color: var(--p-amber-600);
  font-style: italic;
}

.asset-detail-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 0.5rem;
  border-top: 1px solid var(--p-content-border-color);
  padding-top: 0.75rem;
}
</style>
