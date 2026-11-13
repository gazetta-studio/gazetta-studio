<script setup lang="ts">
/**
 * Replace file, in the asset detail pane: the states of design-media.md
 * "Replace (cut 1, M3)". Presentational: `useAssetReplace` owns the flow
 * and passes the state in.
 */
import { computed, ref } from 'vue'
import Button from './ui/Button.vue'
import { mimeCategory, type ReplaceState } from '../composables/useAssetReplace.js'
import { buildAssetUrl, extFromMime } from '../utils/assetUrl.js'

const props = defineProps<{
  assetName: string
  assetMime: string
  state: ReplaceState
  /** AI alt text is configured on the active target. */
  aiAvailable?: boolean
}>()

const emit = defineEmits<{
  choose: [file: File]
  editAlt: []
  editFocal: []
  suggest: []
  dismiss: []
}>()

const input = ref<HTMLInputElement | null>(null)

const category = computed(() => mimeCategory(props.assetMime))
const accept = computed(() => `${category.value}/*`)

/** "an image", "audio", ... as the wrong-kind sentence reads them. */
function kindPhrase(cat: string): string {
  switch (cat) {
    case 'image':
      return 'an image'
    case 'audio':
      return 'audio'
    case 'video':
      return 'a video'
    case 'font':
      return 'a font'
    default:
      return 'a document'
  }
}

const kindError = computed(() => {
  if (props.state.kind !== 'wrong-kind') return ''
  const asset = kindPhrase(category.value)
  return `This file is ${kindPhrase(props.state.fileCategory)}; ${props.assetName} is ${asset}. Choose ${asset}.`
})

const done = computed(() => (props.state.kind === 'done' ? props.state : null))

const preview = computed(() => {
  if (!done.value) return null
  const ext = extFromMime(done.value.asset.mime)
  return ext ? buildAssetUrl({ name: done.value.asset.name, hash: done.value.asset.hash, ext }) : null
})

const altText = computed(() => {
  const alt = done.value?.asset.alt
  if (alt === null || alt === undefined) return 'Not set'
  return alt === '' ? 'Decorative' : alt
})

const focal = computed(() => done.value?.asset.focalPoint ?? null)
const focalText = computed(() =>
  focal.value ? `${Math.round(focal.value.x * 100)}% × ${Math.round(focal.value.y * 100)}%` : 'Center',
)
const objectPosition = computed(() => (focal.value ? `${focal.value.x * 100}% ${focal.value.y * 100}%` : '50% 50%'))

function onChange(event: Event): void {
  const el = event.target as HTMLInputElement
  const file = el.files?.[0]
  // Clear so choosing the same file again still fires `change`.
  el.value = ''
  if (file) emit('choose', file)
}
</script>

<template>
  <div class="asset-replace" data-testid="asset-replace" :data-state="state.kind">
    <Button
      label="Replace file"
      text
      size="small"
      :loading="state.kind === 'working'"
      data-testid="asset-detail-replace"
      @click="input?.click()" />
    <input
      ref="input"
      type="file"
      class="asset-replace-input"
      :accept="accept"
      aria-label="Replace file"
      tabindex="-1"
      data-testid="asset-detail-replace-input"
      @change="onChange" />

    <p v-if="state.kind === 'wrong-kind'" class="asset-replace-error" role="alert" data-testid="replace-kind-error">
      {{ kindError }}
    </p>
    <p v-else-if="state.kind === 'working'" class="asset-replace-progress" role="status" data-testid="replace-progress">
      Replacing {{ assetName }}…
    </p>
    <p v-else-if="state.kind === 'failed'" class="asset-replace-error" role="alert" data-testid="replace-error">
      Couldn't replace {{ assetName }}: {{ state.reason }}. Nothing changed.
    </p>

    <div v-if="done" class="asset-replace-note" role="status" data-testid="replace-note">
      <img
        v-if="preview"
        class="asset-replace-preview"
        :src="preview"
        :alt="done.asset.alt ?? ''"
        :style="{ objectPosition }" />
      <p class="asset-replace-note-text">Check the alt text and focal point still fit the new image.</p>
      <dl class="asset-replace-fields">
        <div>
          <dt>Alt</dt>
          <dd>{{ altText }}</dd>
        </div>
        <div>
          <dt>Focal point</dt>
          <dd>{{ focalText }}</dd>
        </div>
      </dl>
      <p v-if="done.perUseAltCount > 0" class="asset-replace-per-use" data-testid="replace-note-per-use">
        Used on {{ done.perUseAltCount }} pages and fragments with their own alt text.
      </p>
      <div class="asset-replace-actions">
        <Button label="Edit alt" text size="small" data-testid="replace-note-edit-alt" @click="emit('editAlt')" />
        <Button
          label="Edit focal point"
          text
          size="small"
          data-testid="replace-note-edit-focal"
          @click="emit('editFocal')" />
        <Button
          v-if="aiAvailable"
          label="Suggest"
          text
          size="small"
          data-testid="replace-note-suggest"
          @click="emit('suggest')" />
        <Button
          label="Dismiss"
          text
          size="small"
          severity="secondary"
          data-testid="replace-note-dismiss"
          @click="emit('dismiss')" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.asset-replace {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.375rem;
  font-size: 0.875rem;
}

.asset-replace-input {
  display: none;
}

.asset-replace-error,
.asset-replace-progress,
.asset-replace-per-use,
.asset-replace-note-text {
  margin: 0;
}

.asset-replace-error {
  color: var(--color-danger);
}

.asset-replace-progress {
  color: var(--color-muted);
}

.asset-replace-note {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  align-self: stretch;
  padding: 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-info-bg);
  color: var(--color-info-fg);
}

.asset-replace-preview {
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  border-radius: var(--radius-sm);
  background: var(--color-hover-bg);
}

.asset-replace-fields {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.asset-replace-fields div {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
}

.asset-replace-fields dd {
  margin: 0;
  text-align: end;
  word-break: break-word;
}

.asset-replace-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}
</style>
