import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAssetsDeleteStore } from '../src/client/stores/assetsDelete.js'
import { AssetInUseError } from '../src/client/api/assets.js'

// Mock the assets API module the store calls. Keep the real
// `AssetInUseError` export (the store branches on it via `instanceof`) —
// only `deleteAsset` is replaced with a spy the tests can configure.
vi.mock('../src/client/api/assets.js', async orig => {
  const actual = await orig<typeof import('../src/client/api/assets.js')>()
  return {
    ...actual,
    deleteAsset: vi.fn(),
  }
})

// Re-import after the mock is set up so we can tweak the spy per test.
const { deleteAsset } = await import('../src/client/api/assets.js')
const deleteAssetMock = deleteAsset as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  setActivePinia(createPinia())
  deleteAssetMock.mockReset()
})

describe('useAssetsDeleteStore', () => {
  it('starts idle with no asset selected', () => {
    const store = useAssetsDeleteStore()
    expect(store.status).toBe('idle')
    expect(store.assetName).toBeNull()
    expect(store.refs).toEqual([])
  })

  it('ask() transitions to confirming and records the asset name', () => {
    const store = useAssetsDeleteStore()
    store.ask('hero')
    expect(store.status).toBe('confirming')
    expect(store.assetName).toBe('hero')
  })

  it('close() resets state from any stage', () => {
    const store = useAssetsDeleteStore()
    store.ask('hero')
    store.close()
    expect(store.status).toBe('idle')
    expect(store.assetName).toBeNull()
  })

  it('confirmDelete() on success closes and resolves true', async () => {
    deleteAssetMock.mockResolvedValue(undefined)
    const store = useAssetsDeleteStore()

    store.ask('hero')
    const result = await store.confirmDelete()

    expect(deleteAssetMock).toHaveBeenCalledWith('hero')
    expect(result).toBe(true)
    expect(store.status).toBe('idle')
  })

  it('confirmDelete() on 409 surfaces the refs and resolves false', async () => {
    const refs = [
      { source: 'page' as const, path: 'pages/home/page.json', componentPath: 'hero' },
      { source: 'fragment' as const, path: 'fragments/promo/fragment.json', componentPath: 'image' },
    ]
    deleteAssetMock.mockRejectedValue(new AssetInUseError('hero', refs))
    const store = useAssetsDeleteStore()

    store.ask('hero')
    const result = await store.confirmDelete()

    expect(result).toBe(false)
    expect(store.status).toBe('in-use')
    expect(store.refs).toEqual(refs)
    // Asset name persists so the in-use dialog can render it.
    expect(store.assetName).toBe('hero')
  })

  it('confirmDelete() on generic error transitions to error with the message', async () => {
    deleteAssetMock.mockRejectedValue(new Error('boom'))
    const store = useAssetsDeleteStore()

    store.ask('hero')
    const result = await store.confirmDelete()

    expect(result).toBe(false)
    expect(store.status).toBe('error')
    expect(store.errorMessage).toBe('boom')
  })

  it('confirmDelete() no-ops when no asset is staged', async () => {
    deleteAssetMock.mockResolvedValue(undefined)
    const store = useAssetsDeleteStore()

    const result = await store.confirmDelete()

    expect(result).toBe(false)
    expect(deleteAssetMock).not.toHaveBeenCalled()
  })

  it('sets status to "deleting" while the request is in flight', async () => {
    let resolveRequest!: () => void
    const requestPromise = new Promise<void>(resolve => {
      resolveRequest = resolve
    })
    deleteAssetMock.mockReturnValue(requestPromise)
    const store = useAssetsDeleteStore()

    store.ask('hero')
    const done = store.confirmDelete()
    // Pinia actions are not batched — after the synchronous part runs the
    // status should be 'deleting' until the request resolves.
    expect(store.status).toBe('deleting')

    resolveRequest()
    await done

    expect(store.status).toBe('idle')
  })
})
