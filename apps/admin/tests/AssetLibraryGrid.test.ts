import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import AssetLibraryGrid from '../src/client/components/AssetLibraryGrid.vue'
import { useAssetsListStore } from '../src/client/stores/assetsList.js'
import { useAssetsPickerStore } from '../src/client/stores/assetsPicker.js'
import { useAssetsSelectionStore } from '../src/client/stores/assetsSelection.js'
import { useSiteStore } from '../src/client/stores/site.js'
import type { AssetSummary } from '../src/client/api/client.js'

function sample(overrides: Partial<AssetSummary> = {}): AssetSummary {
  return {
    name: 'hero',
    kind: 'embedded',
    mime: 'image/jpeg',
    size: 1000,
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
  site.manifest = {
    name: 'test',
    locale: defaultLocale,
    locales: { supported },
  } as unknown as typeof site.manifest
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('AssetLibraryGrid', () => {
  it('shows a loading state before the list loads', () => {
    const list = useAssetsListStore()
    list.loading = true
    list.loaded = false

    const wrapper = mount(AssetLibraryGrid)
    expect(wrapper.find('[data-testid="asset-grid-loading"]').exists()).toBe(true)
  })

  it('shows an empty state when loaded with no assets', () => {
    const list = useAssetsListStore()
    list.loaded = true
    list.assets = []

    const wrapper = mount(AssetLibraryGrid)
    expect(wrapper.find('[data-testid="asset-grid-empty"]').exists()).toBe(true)
  })

  it('shows an error state when the list has an error', () => {
    const list = useAssetsListStore()
    list.loaded = false
    list.error = 'network failure'

    const wrapper = mount(AssetLibraryGrid)
    const err = wrapper.find('[data-testid="asset-grid-error"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('network failure')
  })

  it('renders one card per asset with the correct thumbnail URL', () => {
    const list = useAssetsListStore()
    list.loaded = true
    list.assets = [
      sample({ name: 'hero', hash: 'aaaaaaaa' }),
      sample({ name: 'logo', hash: 'bbbbbbbb', mime: 'image/png' }),
    ]

    const wrapper = mount(AssetLibraryGrid)
    const cards = wrapper.findAll('[data-testid^="asset-card-"]')
    expect(cards).toHaveLength(2)

    const heroImg = wrapper.find('[data-testid="asset-card-hero"] img')
    expect(heroImg.attributes('src')).toBe('/assets/hero-aaaaaaaa.jpg')

    const logoImg = wrapper.find('[data-testid="asset-card-logo"] img')
    expect(logoImg.attributes('src')).toBe('/assets/logo-bbbbbbbb.png')
  })

  it('clicking a card updates selection', async () => {
    const list = useAssetsListStore()
    const selection = useAssetsSelectionStore()
    list.loaded = true
    list.assets = [sample({ name: 'hero' })]

    const wrapper = mount(AssetLibraryGrid)
    await wrapper.find('[data-testid="asset-card-hero"]').trigger('click')

    expect(selection.selectedName).toBe('hero')
  })

  it('applies the selected class to the currently selected card', () => {
    const list = useAssetsListStore()
    const selection = useAssetsSelectionStore()
    list.loaded = true
    list.assets = [sample({ name: 'hero' }), sample({ name: 'banner' })]
    selection.select('banner')

    const wrapper = mount(AssetLibraryGrid)
    const hero = wrapper.find('[data-testid="asset-card-hero"]')
    const banner = wrapper.find('[data-testid="asset-card-banner"]')

    expect(hero.classes()).not.toContain('selected')
    expect(banner.classes()).toContain('selected')
  })

  describe('picker accept-filter', () => {
    it('shows every asset when picker is closed (browsing mode)', () => {
      const list = useAssetsListStore()
      list.loaded = true
      list.assets = [sample({ name: 'photo', mime: 'image/jpeg' }), sample({ name: 'doc', mime: 'application/pdf' })]
      // Picker not opened — accept is empty default.
      const wrapper = mount(AssetLibraryGrid)
      expect(wrapper.findAll('[data-testid^="asset-card-"]')).toHaveLength(2)
    })

    it('shows every asset when picker is open with empty accept', () => {
      const list = useAssetsListStore()
      const picker = useAssetsPickerStore()
      list.loaded = true
      list.assets = [sample({ name: 'photo', mime: 'image/jpeg' }), sample({ name: 'doc', mime: 'application/pdf' })]
      picker.open({}, () => {})

      const wrapper = mount(AssetLibraryGrid)
      expect(wrapper.findAll('[data-testid^="asset-card-"]')).toHaveLength(2)
    })

    it('filters out assets whose kind does not match accept', () => {
      const list = useAssetsListStore()
      const picker = useAssetsPickerStore()
      list.loaded = true
      list.assets = [
        sample({ name: 'photo', mime: 'image/jpeg' }),
        sample({ name: 'doc', kind: 'downloadable', mime: 'application/pdf' }),
      ]
      picker.open({ accept: ['image'] }, () => {})

      const wrapper = mount(AssetLibraryGrid)
      const cards = wrapper.findAll('[data-testid^="asset-card-"]')
      expect(cards).toHaveLength(1)
      expect(wrapper.find('[data-testid="asset-card-photo"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="asset-card-doc"]').exists()).toBe(false)
    })

    it('respects MIME prefix filters', () => {
      const list = useAssetsListStore()
      const picker = useAssetsPickerStore()
      list.loaded = true
      list.assets = [sample({ name: 'photo', mime: 'image/jpeg' }), sample({ name: 'video', mime: 'video/mp4' })]
      picker.open({ accept: ['image/'] }, () => {})

      const wrapper = mount(AssetLibraryGrid)
      const cards = wrapper.findAll('[data-testid^="asset-card-"]')
      expect(cards).toHaveLength(1)
      expect(wrapper.find('[data-testid="asset-card-photo"]').exists()).toBe(true)
    })

    it('shows a filter-aware empty state when accept hides everything', () => {
      const list = useAssetsListStore()
      const picker = useAssetsPickerStore()
      list.loaded = true
      list.assets = [sample({ name: 'doc', kind: 'downloadable', mime: 'application/pdf' })]
      picker.open({ accept: ['image'] }, () => {})

      const wrapper = mount(AssetLibraryGrid)
      const empty = wrapper.find('[data-testid="asset-grid-empty"]')
      expect(empty.exists()).toBe(true)
      expect(empty.text()).toContain('No assets match the requested type')
    })
  })

  describe('locale coverage badges', () => {
    it('does not render the badge strip when i18n is disabled', () => {
      const list = useAssetsListStore()
      list.loaded = true
      list.assets = [sample({ name: 'hero' })]

      const wrapper = mount(AssetLibraryGrid)
      expect(wrapper.find('[data-testid="coverage-hero"]').exists()).toBe(false)
    })

    it('renders one chip per supported locale, with default first', () => {
      setSiteLocales(['en', 'fr', 'ar'], 'en')
      const list = useAssetsListStore()
      list.loaded = true
      list.assets = [sample({ name: 'hero', overrideLocales: ['fr'] })]

      const wrapper = mount(AssetLibraryGrid)
      expect(wrapper.find('[data-testid="coverage-chip-hero-en"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="coverage-chip-hero-fr"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="coverage-chip-hero-ar"]').exists()).toBe(true)
    })

    it('marks default locale as default, override locale as override, missing as fallback', () => {
      setSiteLocales(['en', 'fr', 'ar'], 'en')
      const list = useAssetsListStore()
      list.loaded = true
      list.assets = [sample({ name: 'hero', overrideLocales: ['fr'] })]

      const wrapper = mount(AssetLibraryGrid)
      const en = wrapper.find('[data-testid="coverage-chip-hero-en"]')
      const fr = wrapper.find('[data-testid="coverage-chip-hero-fr"]')
      const ar = wrapper.find('[data-testid="coverage-chip-hero-ar"]')

      expect(en.classes()).toContain('coverage-default')
      expect(fr.classes()).toContain('coverage-override')
      expect(ar.classes()).toContain('coverage-fallback')
    })
  })

  describe('alt missing badge', () => {
    it('renders the badge when an image has alt === null', () => {
      const list = useAssetsListStore()
      list.loaded = true
      list.assets = [sample({ name: 'hero', alt: null })]

      const wrapper = mount(AssetLibraryGrid)
      expect(wrapper.find('[data-testid="alt-missing-hero"]').exists()).toBe(true)
    })

    it('does NOT render the badge when alt is "" (decorative)', () => {
      const list = useAssetsListStore()
      list.loaded = true
      list.assets = [sample({ name: 'hero', alt: '' })]

      const wrapper = mount(AssetLibraryGrid)
      expect(wrapper.find('[data-testid="alt-missing-hero"]').exists()).toBe(false)
    })

    it('does NOT render the badge when alt is a meaningful string', () => {
      const list = useAssetsListStore()
      list.loaded = true
      list.assets = [sample({ name: 'hero', alt: 'A described image' })]

      const wrapper = mount(AssetLibraryGrid)
      expect(wrapper.find('[data-testid="alt-missing-hero"]').exists()).toBe(false)
    })

    it('does NOT render the badge for non-image assets', () => {
      const list = useAssetsListStore()
      list.loaded = true
      list.assets = [
        sample({ name: 'doc', kind: 'downloadable', mime: 'application/pdf', alt: null }),
        sample({ name: 'font', kind: 'font', mime: 'font/woff2', alt: null }),
      ]

      const wrapper = mount(AssetLibraryGrid)
      expect(wrapper.find('[data-testid="alt-missing-doc"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="alt-missing-font"]').exists()).toBe(false)
    })
  })
})
