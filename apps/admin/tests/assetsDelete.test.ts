import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAssetsDeleteStore } from '../src/client/stores/assetsDelete.js'
import { api, AssetInUseError } from '../src/client/api/client.js'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.restoreAllMocks()
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
    const store = useAssetsDeleteStore()
    const deleteAsset = vi.spyOn(api, 'deleteAsset').mockResolvedValue(undefined)

    store.ask('hero')
    const result = await store.confirmDelete()

    expect(deleteAsset).toHaveBeenCalledWith('hero')
    expect(result).toBe(true)
    expect(store.status).toBe('idle')
  })

  it('confirmDelete() on 409 surfaces the refs and resolves false', async () => {
    const store = useAssetsDeleteStore()
    const refs = [
      { source: 'page' as const, path: 'pages/home/page.json', componentPath: 'hero' },
      { source: 'fragment' as const, path: 'fragments/promo/fragment.json', componentPath: 'image' },
    ]
    vi.spyOn(api, 'deleteAsset').mockRejectedValue(new AssetInUseError('hero', refs))

    store.ask('hero')
    const result = await store.confirmDelete()

    expect(result).toBe(false)
    expect(store.status).toBe('in-use')
    expect(store.refs).toEqual(refs)
    // Asset name persists so the in-use dialog can render it.
    expect(store.assetName).toBe('hero')
  })

  it('confirmDelete() on generic error transitions to error with the message', async () => {
    const store = useAssetsDeleteStore()
    vi.spyOn(api, 'deleteAsset').mockRejectedValue(new Error('boom'))

    store.ask('hero')
    const result = await store.confirmDelete()

    expect(result).toBe(false)
    expect(store.status).toBe('error')
    expect(store.errorMessage).toBe('boom')
  })

  it('confirmDelete() no-ops when no asset is staged', async () => {
    const store = useAssetsDeleteStore()
    const deleteAsset = vi.spyOn(api, 'deleteAsset').mockResolvedValue(undefined)

    const result = await store.confirmDelete()

    expect(result).toBe(false)
    expect(deleteAsset).not.toHaveBeenCalled()
  })

  it('sets status to "deleting" while the request is in flight', async () => {
    const store = useAssetsDeleteStore()
    let resolveRequest!: () => void
    const requestPromise = new Promise<void>(resolve => {
      resolveRequest = resolve
    })
    vi.spyOn(api, 'deleteAsset').mockReturnValue(requestPromise)

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
