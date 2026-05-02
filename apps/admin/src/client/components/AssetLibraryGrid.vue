<script setup lang="ts">
/**
 * Asset library grid — renders every asset known to the list store as a
 * clickable card. Pure presentation: reads from `assetsList`, writes
 * selection via `assetsSelection`. No fetching, no state beyond what the
 * stores expose.
 *
 * Image thumbnails use the full-size bytes for v1 (CSS-sized down).
 * Variant thumbnails arrive with the variant-generation work in a later
 * step; the grid reads the same URL either way.
 */
import { computed } from 'vue'
import { matchesAccept, type AcceptFilter } from 'gazetta/schema'
import { useAssetsListStore } from '../stores/assetsList.js'
import { useAssetsPickerStore } from '../stores/assetsPicker.js'
import { useAssetsSelectionStore } from '../stores/assetsSelection.js'
import { useLocaleStore } from '../stores/locale.js'
import { ASSETS_URL_PREFIX, buildAssetUrl, extFromMime } from '../utils/assetUrl.js'

const list = useAssetsListStore()
const picker = useAssetsPickerStore()
const selection = useAssetsSelectionStore()
const locale = useLocaleStore()

/**
 * Locales the site supports, in display order. Used to render the
 * library card's coverage badge — one chip per supported locale.
 * Empty when i18n is disabled (badge isn't shown in that case).
 */
const siteLocales = computed<readonly string[]>(() => locale.siteLocales ?? [])
const defaultLocale = computed(() => locale.defaultLocale)

// When the picker is open and carries an accept filter, narrow the grid
// to assets that match. Browsing-library mode (picker closed, or open
// with empty accept) shows everything. The same library content powers
// both surfaces; the filter is what distinguishes "select compatible"
// from "browse all."
const filtered = computed(() => {
  if (!picker.isOpen || picker.accept.length === 0) return list.assets
  const accept = picker.accept as AcceptFilter[]
  return list.assets.filter(a => matchesAccept(a, accept))
})

const cards = computed(() =>
  filtered.value.map(a => ({
    ...a,
    thumbUrl: thumbnailUrl(a.name, a.hash, a.mime),
  })),
)

function thumbnailUrl(name: string, hash: string, mime: string): string | null {
  const ext = extFromMime(mime)
  if (!ext) return null
  return buildAssetUrl({ name, hash, ext })
}

function onCardClick(name: string): void {
  selection.select(name)
}

/**
 * Per-card per-locale coverage status:
 *   - `default` — this is the site default locale (always covered)
 *   - `override` — asset has its own bytes for this locale
 *   - `fallback` — no override; this locale uses default bytes
 *
 * Three-state design (vs. binary ✓/—) reflects the model: locales without
 * an override aren't "missing" — they fall back. The chip styling
 * encodes that distinction.
 */
function coverageStatus(
  card: { overrideLocales: readonly string[] },
  localeCode: string,
): 'default' | 'override' | 'fallback' {
  if (localeCode === defaultLocale.value) return 'default'
  return card.overrideLocales.includes(localeCode) ? 'override' : 'fallback'
}

/**
 * Whether to render the "alt missing" badge on this card.
 *
 * Only images can have alt — downloadables (PDF, ZIP) and fonts don't.
 * Decorative ('') and meaningful (string) both pass; null is the
 * "didn't engage" state we surface.
 */
function needsAltBadge(card: { mime: string; kind: string; alt: string | null }): boolean {
  if (card.kind !== 'embedded') return false
  if (!card.mime.startsWith('image/')) return false
  return card.alt === null
}
</script>

<template>
  <div class="asset-grid-wrap" data-testid="asset-grid">
    <div v-if="list.loading && !list.loaded" class="asset-grid-state" data-testid="asset-grid-loading">
      Loading…
    </div>
    <div v-else-if="list.error" class="asset-grid-state asset-grid-error" data-testid="asset-grid-error">
      {{ list.error }}
    </div>
    <div v-else-if="cards.length === 0" class="asset-grid-state" data-testid="asset-grid-empty">
      <span v-if="picker.isOpen && picker.accept.length > 0 && list.assets.length > 0">
        No assets match the requested type. Upload a compatible file or cancel.
      </span>
      <span v-else>No assets yet. Drop files into the upload zone above to get started.</span>
    </div>
    <div v-else class="asset-grid">
      <button
        v-for="card in cards"
        :key="card.name"
        :class="['asset-card', { selected: selection.isSelected(card.name) }]"
        :data-testid="`asset-card-${card.name}`"
        @click="onCardClick(card.name)">
        <div class="asset-card-thumb">
          <img v-if="card.thumbUrl" :src="card.thumbUrl" :alt="card.alt ?? ''" />
          <i v-else class="pi pi-file" />
          <!--
            "Alt missing" badge — visible only on images whose alt is
            null. Decorative ('') and string alt both pass; null is the
            "didn't engage" state (per design-media.md three-state
            model) that the badge surfaces for retroactive remediation.
          -->
          <span
            v-if="needsAltBadge(card)"
            class="asset-card-alt-badge"
            :title="'Alt text not set — accessibility'"
            :data-testid="`alt-missing-${card.name}`">
            ALT
          </span>
        </div>
        <div class="asset-card-name">{{ card.name }}</div>
        <div
          v-if="siteLocales.length > 1"
          class="asset-card-coverage"
          :data-testid="`coverage-${card.name}`">
          <span
            v-for="localeCode in siteLocales"
            :key="localeCode"
            :class="['coverage-chip', `coverage-${coverageStatus(card, localeCode)}`]"
            :title="`${localeCode}: ${coverageStatus(card, localeCode)}`"
            :data-testid="`coverage-chip-${card.name}-${localeCode}`">
            {{ localeCode }}
          </span>
        </div>
      </button>
    </div>
  </div>
</template>

<style scoped>
.asset-grid-wrap {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.asset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 0.75rem;
  padding: 0.25rem;
}

.asset-grid-state {
  padding: 2rem;
  text-align: center;
  color: var(--p-text-muted-color);
}

.asset-grid-error {
  color: var(--p-red-500);
}

.asset-card {
  border: 2px solid transparent;
  border-radius: 8px;
  padding: 0;
  background: var(--p-content-background);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  overflow: hidden;
  font: inherit;
  color: inherit;
  text-align: start;
}

.asset-card:hover {
  border-color: var(--p-primary-color);
}

.asset-card.selected {
  border-color: var(--p-primary-color);
  box-shadow: 0 0 0 2px var(--p-primary-color);
}

.asset-card-thumb {
  aspect-ratio: 1 / 1;
  background: var(--p-content-hover-background);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  position: relative;
}

.asset-card-alt-badge {
  position: absolute;
  top: 0.25rem;
  inset-inline-start: 0.25rem;
  font-size: 0.625rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  padding: 0.0625rem 0.375rem;
  border-radius: 999px;
  background: var(--p-amber-500, #f59e0b);
  color: #fff;
  pointer-events: none;
}

.asset-card-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.asset-card-thumb i {
  font-size: 2rem;
  color: var(--p-text-muted-color);
}

.asset-card-name {
  padding: 0.5rem 0.75rem 0.25rem;
  font-size: 0.875rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.asset-card-coverage {
  padding: 0 0.5rem 0.5rem;
  display: flex;
  flex-wrap: wrap;
  gap: 0.125rem;
}

.coverage-chip {
  font-size: 0.625rem;
  font-weight: 600;
  padding: 0.0625rem 0.25rem;
  border-radius: 999px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  line-height: 1.4;
}

.coverage-default {
  background: var(--p-primary-color);
  color: var(--p-primary-contrast-color);
}

.coverage-override {
  background: var(--p-blue-100);
  color: var(--p-blue-900);
}

.coverage-fallback {
  background: var(--p-content-hover-background);
  color: var(--p-text-muted-color);
  border: 1px dashed var(--p-content-border-color);
}

:global(.dark) .coverage-override {
  background: var(--p-blue-950);
  color: var(--p-blue-300);
}
</style>
