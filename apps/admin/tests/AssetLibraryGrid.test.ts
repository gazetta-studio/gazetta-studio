import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import AssetLibraryGrid from '../src/client/components/AssetLibraryGrid.vue'
import { useAssetsListStore } from '../src/client/stores/assetsList.js'
import { useAssetsSelectionStore } from '../src/client/stores/assetsSelection.js'
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
    ...overrides,
  }
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
})
