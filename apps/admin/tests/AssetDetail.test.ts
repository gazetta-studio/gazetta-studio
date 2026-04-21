import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import AssetDetail from '../src/client/components/AssetDetail.vue'
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
    alt: 'Mountain sunset',
    uploadedAt: '2026-04-22T12:00:00.000Z',
    ...overrides,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('AssetDetail', () => {
  it('shows an empty state with nothing selected', () => {
    const wrapper = mount(AssetDetail)
    expect(wrapper.find('[data-testid="asset-detail-empty"]').exists()).toBe(true)
  })

  it('shows the selected asset with name and preview', () => {
    const list = useAssetsListStore()
    const selection = useAssetsSelectionStore()
    list.assets = [sample()]
    selection.select('hero')

    const wrapper = mount(AssetDetail)
    expect(wrapper.find('[data-testid="asset-detail-empty"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="asset-detail-name"]').text()).toBe('hero')
    expect(wrapper.find('img').attributes('src')).toBe('/assets/hero-aaaaaaaa.jpg')
  })

  it('renders kind, mime, size in human-readable format', () => {
    const list = useAssetsListStore()
    const selection = useAssetsSelectionStore()
    list.assets = [sample({ size: 1024 * 1024 * 2 })]
    selection.select('hero')

    const wrapper = mount(AssetDetail)
    const text = wrapper.text()
    expect(text).toContain('embedded')
    expect(text).toContain('image/jpeg')
    expect(text).toContain('2.0 MB')
  })

  it('renders dimensions when both width and height are present', () => {
    const list = useAssetsListStore()
    const selection = useAssetsSelectionStore()
    list.assets = [sample({ width: 1920, height: 1080 })]
    selection.select('hero')

    const wrapper = mount(AssetDetail)
    expect(wrapper.text()).toContain('1920 × 1080')
  })

  it('omits dimensions when width or height is null', () => {
    const list = useAssetsListStore()
    const selection = useAssetsSelectionStore()
    list.assets = [sample({ width: null, height: null })]
    selection.select('hero')

    const wrapper = mount(AssetDetail)
    expect(wrapper.text()).not.toContain('×')
  })

  it('shows alt text when set', () => {
    const list = useAssetsListStore()
    const selection = useAssetsSelectionStore()
    list.assets = [sample({ alt: 'My great photo' })]
    selection.select('hero')

    const wrapper = mount(AssetDetail)
    expect(wrapper.text()).toContain('My great photo')
  })

  it('shows "(decorative)" hint when alt is empty string', () => {
    const list = useAssetsListStore()
    const selection = useAssetsSelectionStore()
    list.assets = [sample({ alt: '' })]
    selection.select('hero')

    const wrapper = mount(AssetDetail)
    expect(wrapper.text()).toContain('(decorative)')
  })

  it('shows "(not set)" hint when alt is null', () => {
    const list = useAssetsListStore()
    const selection = useAssetsSelectionStore()
    list.assets = [sample({ alt: null })]
    selection.select('hero')

    const wrapper = mount(AssetDetail)
    expect(wrapper.text()).toContain('(not set)')
  })

  it('reverts to empty state when selection clears', async () => {
    const list = useAssetsListStore()
    const selection = useAssetsSelectionStore()
    list.assets = [sample()]
    selection.select('hero')

    const wrapper = mount(AssetDetail)
    expect(wrapper.find('[data-testid="asset-detail-empty"]').exists()).toBe(false)

    selection.clear()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="asset-detail-empty"]').exists()).toBe(true)
  })
})
