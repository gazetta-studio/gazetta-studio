<script setup lang="ts">
/**
 * Locale-bytes section of the asset detail pane.
 *
 * Always visible when i18n is enabled for the site. Shows:
 *
 *   - "Default" row — always present, the canonical asset bytes
 *   - One row per existing locale-bytes override — chip + size badge
 *     + remove-override action
 *   - "+ Add {locale} version" buttons for site-supported locales that
 *     don't yet have an override
 *
 * Distinct from AEM's References → Language Copies pane in that we
 * surface the action affordances inline (no nested panel), and we
 * include "+ Add" entries for unconfigured locales (AEM requires going
 * to Translation Project workflow). Closer to a focused per-row UI.
 *
 * The data source is `assetsList.assets` for the current asset's
 * `overrideLocales`. After a locale-bytes upload or removal, the
 * upload-zone / remove action triggers a list refresh; this component
 * just reads the result.
 */
import { computed } from 'vue'
import Button from 'primevue/button'
import { formatBytes } from 'gazetta/format'
import type { AssetSummary } from 'gazetta/schema'
import { useAssetsUploadStore } from '../stores/assetsUpload.js'
import { useLocaleStore } from '../stores/locale.js'
import { useAssetsListStore } from '../stores/assetsList.js'
import { removeLocaleOverride } from '../api/assets.js'

const props = defineProps<{
  /** The asset whose locale section we're rendering. */
  asset: AssetSummary
}>()

const uploads = useAssetsUploadStore()
const locale = useLocaleStore()
const list = useAssetsListStore()

/**
 * Locales the site supports, minus the default. Default is always
 * shown as a separate row at the top; the "Add … version" buttons
 * only make sense for non-default locales.
 */
const nonDefaultLocales = computed<readonly string[]>(() => {
  if (!locale.isEnabled) return []
  const all = locale.siteLocales ?? []
  return all.filter(l => l !== locale.defaultLocale)
})

const overrideLocales = computed(() => new Set(props.asset.overrideLocales))

const missingLocales = computed(() => nonDefaultLocales.value.filter(l => !overrideLocales.value.has(l)))

const fileInputs = new Map<string, HTMLInputElement>()
function setInputRef(localeCode: string, el: HTMLInputElement | null) {
  if (el) fileInputs.set(localeCode, el)
  else fileInputs.delete(localeCode)
}

function triggerUpload(localeCode: string): void {
  fileInputs.get(localeCode)?.click()
}

function onFilePicked(event: Event, localeCode: string): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  uploads.enqueueLocaleBytes(file, props.asset.name, { locale: localeCode })
  input.value = ''
}

async function onRemoveOverride(localeCode: string): Promise<void> {
  // Hard remove in v1. Future enhancement: confirmation dialog with
  // "{locale} pages will use default bytes after this. Continue?"
  // (per design-media.md). Skipped for v1 to keep the surface tight.
  try {
    await removeLocaleOverride(props.asset.name, { locale: localeCode })
    await list.refresh()
  } catch (err) {
    // Surface as an inline error chip in a follow-up. For v1 the
    // store-driven list refresh + the absence of the row reflects
    // success; failure leaves the row in place and logs.
    // eslint-disable-next-line no-console
    console.error(`Failed to remove ${localeCode} override:`, err)
  }
}

if (uploads) {
  // Bridge: when an upload completes we want the list to refresh so the
  // override row appears. The library's existing watcher in AssetUploadZone
  // already triggers a refresh — this component reads from that refreshed
  // list, no extra wiring needed here.
}
</script>

<template>
  <section v-if="locale.isEnabled" class="locale-section" data-testid="asset-detail-locale-section">
    <h3 class="locale-section-title">Locale bytes</h3>

    <div class="locale-row" data-testid="locale-row-default">
      <div class="locale-row-label">
        <span class="locale-chip default-chip">Default</span>
        <span v-if="locale.defaultLocale" class="locale-row-code">{{ locale.defaultLocale }}</span>
      </div>
      <div class="locale-row-meta">
        <span>{{ formatBytes(asset.size) }}</span>
        <span v-if="asset.width !== null && asset.height !== null">{{ asset.width }}×{{ asset.height }}</span>
      </div>
    </div>

    <div
      v-for="localeCode in asset.overrideLocales"
      :key="localeCode"
      class="locale-row"
      :data-testid="`locale-row-${localeCode}`">
      <div class="locale-row-label">
        <span class="locale-chip override-chip">{{ localeCode }}</span>
        <span class="locale-row-code">override</span>
      </div>
      <div class="locale-row-meta">
        <Button
          label="Remove override"
          severity="danger"
          text
          size="small"
          :data-testid="`locale-row-remove-${localeCode}`"
          @click="onRemoveOverride(localeCode)" />
      </div>
    </div>

    <div v-if="missingLocales.length > 0" class="locale-add-row">
      <Button
        v-for="localeCode in missingLocales"
        :key="localeCode"
        :label="`+ Add ${localeCode} version`"
        text
        size="small"
        :data-testid="`locale-add-${localeCode}`"
        @click="triggerUpload(localeCode)" />
      <input
        v-for="localeCode in missingLocales"
        :key="`input-${localeCode}`"
        :ref="el => setInputRef(localeCode, el as HTMLInputElement | null)"
        type="file"
        accept="image/jpeg,image/png"
        class="locale-add-input"
        :data-testid="`locale-add-input-${localeCode}`"
        @change="event => onFilePicked(event, localeCode)" />
    </div>
  </section>
</template>


<style scoped>
.locale-section {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  border-top: 1px solid var(--p-content-border-color);
  padding-top: 0.75rem;
  margin-top: 0.5rem;
}

.locale-section-title {
  font-size: 0.875rem;
  font-weight: 600;
  margin: 0;
  color: var(--p-text-muted-color);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.locale-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.375rem 0.5rem;
  border-radius: 4px;
  background: var(--p-content-hover-background);
  font-size: 0.875rem;
}

.locale-row-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.locale-chip {
  padding: 0.125rem 0.5rem;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.default-chip {
  background: var(--p-primary-color);
  color: var(--p-primary-contrast-color);
}

.override-chip {
  background: var(--p-blue-100);
  color: var(--p-blue-900);
}

:global(.dark) .override-chip {
  background: var(--p-blue-950);
  color: var(--p-blue-300);
}

.locale-row-code {
  color: var(--p-text-muted-color);
  font-size: 0.75rem;
}

.locale-row-meta {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--p-text-muted-color);
  font-size: 0.75rem;
}

.locale-add-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}

.locale-add-input {
  display: none;
}
</style>
