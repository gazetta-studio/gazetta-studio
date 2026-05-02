<script setup lang="ts">
/**
 * Upload prompt modal — "default vs override" decision dialog.
 *
 * Shown when the author drops a file whose derived name matches an
 * existing default asset AND the active locale is not the default
 * locale. The author picks:
 *
 *   - Replace default — the new bytes become the canonical asset bytes.
 *     Every locale that doesn't have its own override now uses these.
 *   - Add override — keep the default intact; the new bytes become this
 *     locale's specific version.
 *   - Cancel — abort the upload.
 *
 * Distinctive vs every CMS we surveyed: nobody asks. Contentful, Strapi,
 * Storyblok, Payload all silently write to whatever locale the editor
 * is on. Gazetta's optional-override model needs the explicit choice
 * because both intents are first-class.
 */
import { computed } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import { useAssetsUploadPromptStore } from '../stores/assetsUploadPrompt.js'

const prompt = useAssetsUploadPromptStore()

const visible = computed({
  get: () => prompt.isOpen,
  set: (v: boolean) => {
    if (!v) prompt.dismiss()
  },
})

const fileName = computed(() => prompt.current?.file.name ?? '')
const fileSize = computed(() => formatSize(prompt.current?.file.size ?? 0))
const localeLabel = computed(() => prompt.current?.activeLocaleLabel ?? prompt.current?.locale ?? '')
const defaultLabel = computed(() => prompt.current?.defaultLocaleLabel ?? 'default locale')

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    :closable="true"
    :style="{ width: '480px' }"
    :header="`Upload ${fileName}`"
    data-testid="upload-prompt">
    <p class="prompt-intro">
      An asset named <strong>{{ prompt.current?.name }}</strong> already exists. The active locale is
      <strong>{{ localeLabel }}</strong
      >. What should happen with this upload?
    </p>
    <div class="prompt-meta">{{ fileSize }} · {{ prompt.current?.file.type }}</div>

    <div class="prompt-options">
      <button
        type="button"
        class="prompt-option"
        data-testid="upload-prompt-replace-default"
        @click="prompt.pick('replace-default')">
        <div class="prompt-option-title">Replace default bytes</div>
        <div class="prompt-option-body">
          The new bytes become the asset's canonical version. Every locale without its own override uses these.
        </div>
      </button>
      <button
        type="button"
        class="prompt-option recommended"
        data-testid="upload-prompt-add-override"
        @click="prompt.pick('add-override')">
        <div class="prompt-option-title">
          Add {{ localeLabel }} bytes override
          <span class="prompt-option-hint">recommended</span>
        </div>
        <div class="prompt-option-body">
          Keep the {{ defaultLabel }} bytes intact. The new bytes are used only when {{ localeLabel }} is the active
          locale.
        </div>
      </button>
    </div>

    <template #footer>
      <Button label="Cancel" text data-testid="upload-prompt-cancel" @click="prompt.pick('cancel')" />
    </template>
  </Dialog>
</template>

<style scoped>
.prompt-intro {
  margin: 0 0 0.25rem;
}

.prompt-meta {
  color: var(--p-text-muted-color);
  font-size: 0.875rem;
  margin-bottom: 1rem;
}

.prompt-options {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.prompt-option {
  display: block;
  width: 100%;
  text-align: start;
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  padding: 0.75rem 1rem;
  background: var(--p-content-background);
  cursor: pointer;
  transition: border-color 120ms, background-color 120ms;
  font: inherit;
  color: inherit;
}

.prompt-option:hover {
  border-color: var(--p-primary-color);
  background: var(--p-content-hover-background);
}

.prompt-option.recommended {
  border-color: var(--p-primary-color);
}

.prompt-option-title {
  font-weight: 600;
  margin-bottom: 0.25rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.prompt-option-hint {
  font-weight: 400;
  font-size: 0.75rem;
  text-transform: uppercase;
  color: var(--p-primary-color);
  letter-spacing: 0.05em;
}

.prompt-option-body {
  font-size: 0.875rem;
  color: var(--p-text-muted-color);
}
</style>
