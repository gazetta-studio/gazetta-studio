import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import PrimeVue from 'primevue/config'
import AssetPicker from '../src/client/components/AssetPicker.vue'
import { useAssetsPickerStore } from '../src/client/stores/assetsPicker.js'
import { useAssetsListStore } from '../src/client/stores/assetsList.js'
import { useAssetsSelectionStore } from '../src/client/stores/assetsSelection.js'

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

beforeEach(() => {
  setActivePinia(createPinia())
})

function render() {
  return mount(AssetPicker, {
    attachTo: document.body,
    global: {
      plugins: [PrimeVue],
      stubs: {
        AssetLibraryContent: true,
      },
    },
  })
}

function dialog(): HTMLElement | null {
  return document.querySelector('[data-testid="asset-picker"]')
}

describe('AssetPicker', () => {
  it('is hidden by default', () => {
    render()
    expect(dialog()).toBeNull()
  })

  it('opens when the picker store is opened and refreshes list', async () => {
    const picker = useAssetsPickerStore()
    const list = useAssetsListStore()
    const refresh = vi.spyOn(list, 'refresh').mockResolvedValue(undefined)

    render()
    picker.open({ accept: ['image'] }, () => {})
    await flushPromises()

    expect(dialog()).not.toBeNull()
    expect(refresh).toHaveBeenCalled()
  })

  it('pre-selects the currentAssetName when opening', async () => {
    const picker = useAssetsPickerStore()
    const selection = useAssetsSelectionStore()

    render()
    picker.open({ currentAssetName: 'hero' }, () => {})
    await flushPromises()

    expect(selection.selectedName).toBe('hero')
  })

  it('confirm fires the resolver with the selected asset', async () => {
    const picker = useAssetsPickerStore()
    const selection = useAssetsSelectionStore()
    const resolver = vi.fn()

    render()
    picker.open({}, resolver)
    await flushPromises()
    // Select AFTER the watcher settles — the open-watcher resets selection
    // to `currentAssetName` (null here), so we pick after that runs.
    selection.select('hero')

    // The confirm button lives in a teleported footer slot of PrimeVue's
    // Dialog; easier to assert the contract via the store action that the
    // button would trigger.
    picker.confirm(selection.selectedName!)

    expect(resolver).toHaveBeenCalledWith({ _asset: 'hero' })
  })

  it('cancel fires the resolver with null', async () => {
    const picker = useAssetsPickerStore()
    const resolver = vi.fn()

    render()
    picker.open({}, resolver)
    await flushPromises()

    picker.cancel()

    expect(resolver).toHaveBeenCalledWith(null)
  })

  it('cancels the picker when the component unmounts while open', async () => {
    const picker = useAssetsPickerStore()
    const resolver = vi.fn()

    const wrapper = render()
    picker.open({}, resolver)
    await flushPromises()

    wrapper.unmount()

    expect(resolver).toHaveBeenCalledWith(null)
  })

  it('clears selection when closed', async () => {
    const picker = useAssetsPickerStore()
    const selection = useAssetsSelectionStore()

    render()
    picker.open({ currentAssetName: 'hero' }, () => {})
    await flushPromises()
    expect(selection.selectedName).toBe('hero')

    picker.cancel()
    await flushPromises()
    expect(selection.selectedName).toBeNull()
  })
})
