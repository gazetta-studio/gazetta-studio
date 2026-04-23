import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAssetsDeleteStore } from '../src/client/stores/assetsDelete.js'
import { AssetInUseError, AssetKindMismatchError } from '../src/client/api/assets.js'

// Mock the assets API module the store calls. Keep the real error
// classes exported (the store branches on them via `instanceof`) —
// only the API functions are replaced with spies the tests configure.
vi.mock('../src/client/api/assets.js', async orig => {
  const actual = await orig<typeof import('../src/client/api/assets.js')>()
  return {
    ...actual,
    deleteAsset: vi.fn(),
    replaceAsset: vi.fn(),
  }
})

// Re-import after the mock is set up so we can tweak the spies per test.
const { deleteAsset, replaceAsset } = await import('../src/client/api/assets.js')
const deleteAssetMock = deleteAsset as unknown as ReturnType<typeof vi.fn>
const replaceAssetMock = replaceAsset as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  setActivePinia(createPinia())
  deleteAssetMock.mockReset()
  replaceAssetMock.mockReset()
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

  // --- replace() flow ---

  async function stageInUse(store: ReturnType<typeof useAssetsDeleteStore>) {
    // Prime the store into the 'in-use' state the same way the UI does:
    // try a delete that fails with AssetInUseError.
    deleteAssetMock.mockRejectedValue(
      new AssetInUseError('hero', [{ source: 'page', path: 'pages/home/page.json', componentPath: 'hero' }]),
    )
    store.ask('hero')
    await store.confirmDelete()
    expect(store.status).toBe('in-use')
  }

  it('replace() on success closes and resolves true', async () => {
    replaceAssetMock.mockResolvedValue(undefined)
    const store = useAssetsDeleteStore()
    await stageInUse(store)

    const result = await store.replace('banner')

    expect(replaceAssetMock).toHaveBeenCalledWith('hero', 'banner')
    expect(result).toBe(true)
    expect(store.status).toBe('idle')
  })

  it('replace() on kind mismatch transitions to kind-mismatch variant with structured detail', async () => {
    replaceAssetMock.mockRejectedValue(new AssetKindMismatchError('embedded', 'image', 'downloadable', 'application'))
    const store = useAssetsDeleteStore()
    await stageInUse(store)

    const result = await store.replace('banner')

    expect(result).toBe(false)
    expect(store.status).toBe('kind-mismatch')
    expect(store.kindMismatch).toEqual({
      oldKind: 'embedded',
      oldMimeCategory: 'image',
      newKind: 'downloadable',
      newMimeCategory: 'application',
    })
    // Asset name persists so the dialog can re-render context.
    expect(store.assetName).toBe('hero')
  })

  it('dismissKindMismatch() returns the user to the in-use view', async () => {
    replaceAssetMock.mockRejectedValue(new AssetKindMismatchError('embedded', 'image', 'embedded', 'video'))
    const store = useAssetsDeleteStore()
    await stageInUse(store)

    await store.replace('clip')
    expect(store.status).toBe('kind-mismatch')

    store.dismissKindMismatch()
    expect(store.status).toBe('in-use')
    expect(store.kindMismatch).toBeNull()
    // Refs list is retained so the author has context for the next pick.
    expect(store.refs).toHaveLength(1)
  })

  it('replace() on generic error transitions to error with the message', async () => {
    replaceAssetMock.mockRejectedValue(new Error('boom'))
    const store = useAssetsDeleteStore()
    await stageInUse(store)

    const result = await store.replace('banner')

    expect(result).toBe(false)
    expect(store.status).toBe('error')
    expect(store.errorMessage).toBe('boom')
  })

  it('replace() no-ops when the store is not in in-use state', async () => {
    const store = useAssetsDeleteStore()
    // Not staged — still 'idle'.
    const result = await store.replace('banner')

    expect(result).toBe(false)
    expect(replaceAssetMock).not.toHaveBeenCalled()
  })

  it('dialogVariant stays "in-use" while a replace is in flight', async () => {
    let resolveRequest!: () => void
    replaceAssetMock.mockReturnValue(
      new Promise<void>(resolve => {
        resolveRequest = resolve
      }),
    )
    const store = useAssetsDeleteStore()
    await stageInUse(store)

    const done = store.replace('banner')
    expect(store.status).toBe('replacing')
    // During the rewrite, the ref list remains visible so the author
    // can see what's being rewritten.
    expect(store.dialogVariant).toBe('in-use')

    resolveRequest()
    await done
    expect(store.status).toBe('idle')
  })
})
