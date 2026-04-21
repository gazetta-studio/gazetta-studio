import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import PrimeVue from 'primevue/config'
import AssetLibrary from '../src/client/components/AssetLibrary.vue'
import { useAssetsLibraryStore } from '../src/client/stores/assetsLibrary.js'
import { useAssetsListStore } from '../src/client/stores/assetsList.js'
import { useAssetsSelectionStore } from '../src/client/stores/assetsSelection.js'

// PrimeVue Dialog relies on window.matchMedia for responsive behavior.
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
  return mount(AssetLibrary, {
    attachTo: document.body,
    global: {
      plugins: [PrimeVue],
      stubs: {
        AssetLibraryGrid: true,
        AssetUploadZone: true,
        AssetDetail: true,
      },
    },
  })
}

/** PrimeVue teleports its Dialog body to `document.body`. Finding it via
 *  the wrapper doesn't work; query the document directly. */
function dialogVisible(): boolean {
  return document.querySelector('[data-testid="asset-library"]') !== null
}

describe('AssetLibrary', () => {
  it('is hidden by default (isOpen=false)', () => {
    render()
    expect(dialogVisible()).toBe(false)
  })

  it('renders when the store opens it', async () => {
    const lib = useAssetsLibraryStore()
    render()
    lib.open()
    await flushPromises()
    expect(dialogVisible()).toBe(true)
  })

  it('triggers list refresh on open', async () => {
    const list = useAssetsListStore()
    const refresh = vi.spyOn(list, 'refresh').mockResolvedValue(undefined)
    const lib = useAssetsLibraryStore()

    render()
    lib.open()
    await flushPromises()

    expect(refresh).toHaveBeenCalled()
  })

  it('clears selection on close', async () => {
    const lib = useAssetsLibraryStore()
    const selection = useAssetsSelectionStore()
    selection.select('hero')

    render()
    lib.open()
    await flushPromises()
    expect(selection.selectedName).toBe('hero')

    lib.close()
    await flushPromises()
    expect(selection.selectedName).toBeNull()
  })
})
