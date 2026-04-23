import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import PrimeVue from 'primevue/config'
import AssetDeleteConfirm from '../src/client/components/AssetDeleteConfirm.vue'
import { useAssetsDeleteStore } from '../src/client/stores/assetsDelete.js'
import { useAssetsListStore } from '../src/client/stores/assetsList.js'
import { useAssetsSelectionStore } from '../src/client/stores/assetsSelection.js'
import { AssetInUseError } from '../src/client/api/assets.js'

vi.mock('../src/client/api/assets.js', async orig => {
  const actual = await orig<typeof import('../src/client/api/assets.js')>()
  return {
    ...actual,
    deleteAsset: vi.fn(),
  }
})

const { deleteAsset } = await import('../src/client/api/assets.js')
const deleteAssetMock = deleteAsset as unknown as ReturnType<typeof vi.fn>

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
  deleteAssetMock.mockReset()
  // PrimeVue's Dialog teleports into document.body; previous tests leave
  // its markup behind. Wipe so queries against document.body see only
  // *this* test's render.
  document.body.innerHTML = ''
})

function render() {
  return mount(AssetDeleteConfirm, {
    attachTo: document.body,
    global: {
      plugins: [PrimeVue],
    },
  })
}

function dialog(): HTMLElement | null {
  return document.querySelector('[data-testid="asset-delete-confirm"]')
}

describe('AssetDeleteConfirm', () => {
  it('is hidden by default', () => {
    render()
    expect(dialog()).toBeNull()
  })

  it('renders the confirm prompt when the store is in "confirming" state', async () => {
    const del = useAssetsDeleteStore()
    render()
    del.ask('hero')
    await flushPromises()

    expect(dialog()).not.toBeNull()
    expect(document.querySelector('[data-testid="asset-delete-name"]')?.textContent).toBe('hero')
    expect(document.querySelector('[data-testid="asset-delete-confirm-button"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="asset-delete-cancel"]')).not.toBeNull()
  })

  // Button clicks route through PrimeVue's Button component whose event
  // wiring is an integration concern. The click-triggers-store-action
  // path is covered by the store test directly. Here we assert: once the
  // store reaches a given status, the component renders the corresponding
  // body. Side effects (refresh, selection clear) also live on the
  // component, so we drive them via the store.

  it('refreshes list and clears selection on successful confirmDelete', async () => {
    deleteAssetMock.mockResolvedValue(undefined)
    const del = useAssetsDeleteStore()
    const list = useAssetsListStore()
    const selection = useAssetsSelectionStore()
    const refresh = vi.spyOn(list, 'refresh').mockResolvedValue(undefined)
    selection.select('hero')

    const wrapper = render()
    del.ask('hero')
    await flushPromises()

    const buttons = wrapper.findAllComponents({ name: 'Button' })
    const confirm = buttons.find(b => b.attributes('data-testid') === 'asset-delete-confirm-button')!
    await confirm.trigger('click')
    await flushPromises()

    expect(deleteAssetMock).toHaveBeenCalledWith('hero')
    expect(refresh).toHaveBeenCalled()
    expect(selection.selectedName).toBeNull()
    expect(del.status).toBe('idle')
  })

  it('cancel button closes the dialog without calling the API', async () => {
    deleteAssetMock.mockResolvedValue(undefined)
    const del = useAssetsDeleteStore()

    const wrapper = render()
    del.ask('hero')
    await flushPromises()

    const buttons = wrapper.findAllComponents({ name: 'Button' })
    const cancel = buttons.find(b => b.attributes('data-testid') === 'asset-delete-cancel')!
    await cancel.trigger('click')
    await flushPromises()

    expect(deleteAssetMock).not.toHaveBeenCalled()
    expect(del.status).toBe('idle')
  })

  it('renders the in-use body with refs + Replace footer when store is in "in-use" state', async () => {
    const del = useAssetsDeleteStore()
    render()
    // Drive directly through the store's public API (the route the UI
    // takes after a failed confirmDelete). The store-level test already
    // covers the 409 → in-use transition.
    del.ask('hero')
    del.$patch(s => {
      s.status = 'in-use'
      s.refs = [{ source: 'page', path: 'pages/home/page.json', componentPath: 'hero' }]
    })
    await flushPromises()

    const refList = document.querySelector('[data-testid="asset-delete-refs"]')
    expect(refList).not.toBeNull()
    expect(refList!.textContent).toContain('pages/home/page.json')
    // Delete/Cancel replaced by Close + Replace.
    expect(document.querySelector('[data-testid="asset-delete-close"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="asset-delete-replace"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="asset-delete-confirm-button"]')).toBeNull()
  })

  it('renders the kind-mismatch body when the store is in "kind-mismatch" state', async () => {
    const del = useAssetsDeleteStore()
    render()
    del.ask('hero')
    del.$patch(s => {
      s.status = 'kind-mismatch'
      s.refs = [{ source: 'page', path: 'pages/home/page.json', componentPath: 'hero' }]
      s.kindMismatch = {
        oldKind: 'embedded',
        oldMimeCategory: 'image',
        newKind: 'embedded',
        newMimeCategory: 'video',
      }
    })
    await flushPromises()

    const detail = document.querySelector('[data-testid="asset-delete-kind-detail"]')
    expect(detail).not.toBeNull()
    expect(detail!.textContent).toContain('embedded')
    expect(detail!.textContent).toContain('image')
    expect(detail!.textContent).toContain('video')
    // Footer has Close + Pick another.
    expect(document.querySelector('[data-testid="asset-delete-close"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="asset-delete-pick-again"]')).not.toBeNull()
  })

  it('shows generic error body when the store is in "error" state', async () => {
    const del = useAssetsDeleteStore()
    render()
    del.ask('hero')
    del.$patch(s => {
      s.status = 'error'
      s.errorMessage = 'storage dropped'
    })
    await flushPromises()

    expect(document.querySelector('[data-testid="asset-delete-close"]')).not.toBeNull()
  })

  it('AssetInUseError from gazetta is the class the store branches on', () => {
    // Anchor: the imported class here is the same one the server throws,
    // re-exported through gazetta/admin-api/schemas and this file.
    expect(new AssetInUseError('x', []).code).toBe('ASSET_IN_USE')
  })
})
