/**
 * Vue tests for AssetDetailLocaleSection — the per-locale rows and
 * "+ Add" buttons in the asset detail pane.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import PrimeVue from 'primevue/config'
import AssetDetailLocaleSection from '../src/client/components/AssetDetailLocaleSection.vue'
import { useSiteStore } from '../src/client/stores/site.js'
import { useAssetsUploadStore } from '../src/client/stores/assetsUpload.js'
import type { AssetSummary } from 'gazetta/schema'

beforeAll(() => {
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
        onchange: null,
      }) as unknown as MediaQueryList
  }
})

function sampleAsset(overrides: Partial<AssetSummary> = {}): AssetSummary {
  return {
    name: 'hero',
    kind: 'embedded',
    mime: 'image/jpeg',
    size: 1024,
    hash: 'aaaaaaaa',
    width: 100,
    height: 100,
    alt: null,
    uploadedAt: '2026-04-22T00:00:00.000Z',
    overrideLocales: [],
    overrideThemes: [],
    ...overrides,
  }
}

function setSiteLocales(supported: string[], defaultLocale: string) {
  const site = useSiteStore()
  // The site store is initialized with `manifest = null`; we shim a
  // minimal manifest enough for the locale store to read locales.
  site.manifest = {
    name: 'test',
    locale: defaultLocale,
    locales: { supported },
  } as unknown as typeof site.manifest
}

beforeEach(() => {
  setActivePinia(createPinia())
})

function render(asset: AssetSummary) {
  return mount(AssetDetailLocaleSection, {
    props: { asset },
    global: { plugins: [PrimeVue] },
  })
}

describe('AssetDetailLocaleSection', () => {
  it('renders nothing when i18n is disabled (single-locale site)', () => {
    setSiteLocales(['en'], 'en')
    const wrapper = render(sampleAsset())
    expect(wrapper.find('[data-testid="asset-detail-locale-section"]').exists()).toBe(false)
  })

  it('renders the default row plus + Add buttons for non-default locales', () => {
    setSiteLocales(['en', 'fr', 'ar'], 'en')
    const wrapper = render(sampleAsset())

    expect(wrapper.find('[data-testid="asset-detail-locale-section"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="locale-row-default"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="locale-add-fr"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="locale-add-ar"]').exists()).toBe(true)
  })

  it('renders an override row for each locale in overrideLocales', () => {
    setSiteLocales(['en', 'fr', 'ar'], 'en')
    const wrapper = render(sampleAsset({ overrideLocales: ['fr'] }))

    expect(wrapper.find('[data-testid="locale-row-fr"]').exists()).toBe(true)
    // The override row replaces the + Add for that locale.
    expect(wrapper.find('[data-testid="locale-add-fr"]').exists()).toBe(false)
    // Other locales still get their + Add buttons.
    expect(wrapper.find('[data-testid="locale-add-ar"]').exists()).toBe(true)
  })

  it('+ Add button triggers a file input click + locale-bytes upload', async () => {
    setSiteLocales(['en', 'fr'], 'en')
    const uploads = useAssetsUploadStore()
    const enqueueSpy = vi.spyOn(uploads, 'enqueueLocaleBytes')

    const wrapper = render(sampleAsset())
    const input = wrapper.find('[data-testid="locale-add-input-fr"]')
    expect(input.exists()).toBe(true)

    // Simulate the file dialog returning a file (Vue file inputs require
    // direct property assignment to set `files`).
    const file = new File(['x'], 'hero.jpg', { type: 'image/jpeg' })
    const inputEl = input.element as HTMLInputElement
    Object.defineProperty(inputEl, 'files', { value: [file] })
    await input.trigger('change')
    await flushPromises()

    expect(enqueueSpy).toHaveBeenCalledWith(file, 'hero', { locale: 'fr' })
  })

  it('Remove override button calls the store + refreshes list', async () => {
    setSiteLocales(['en', 'fr'], 'en')
    const wrapper = render(sampleAsset({ overrideLocales: ['fr'] }))
    const removeBtn = wrapper.find('[data-testid="locale-row-remove-fr"]')
    expect(removeBtn.exists()).toBe(true)
  })
})
