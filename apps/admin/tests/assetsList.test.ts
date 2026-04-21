import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAssetsListStore } from '../src/client/stores/assetsList.js'
import type { AssetSummary } from '../src/client/api/client.js'

function sampleSummary(overrides: Partial<AssetSummary> = {}): AssetSummary {
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

describe('assetsList store', () => {
  it('starts in an unloaded state', () => {
    const store = useAssetsListStore()
    expect(store.assets).toEqual([])
    expect(store.loading).toBe(false)
    expect(store.loaded).toBe(false)
    expect(store.error).toBeNull()
    expect(store.count).toBe(0)
  })

  it('refresh fetches, sets loaded=true, and populates assets', async () => {
    const store = useAssetsListStore()
    store.configure({
      loadList: async () => [sampleSummary({ name: 'one' }), sampleSummary({ name: 'two' })],
    })

    await store.refresh()

    expect(store.loaded).toBe(true)
    expect(store.loading).toBe(false)
    expect(store.count).toBe(2)
    expect(store.assets.map(a => a.name)).toEqual(['one', 'two'])
    expect(store.error).toBeNull()
  })

  it('refresh deduplicates concurrent calls via an in-flight promise', async () => {
    const store = useAssetsListStore()
    const loadList = vi.fn(async () => [sampleSummary()])
    store.configure({ loadList })

    await Promise.all([store.refresh(), store.refresh(), store.refresh()])

    expect(loadList).toHaveBeenCalledTimes(1)
  })

  it('populates error and leaves assets empty on fetch failure', async () => {
    const store = useAssetsListStore()
    store.configure({
      loadList: async () => {
        throw new Error('network error')
      },
    })

    await store.refresh()

    expect(store.error).toBe('network error')
    expect(store.assets).toEqual([])
    expect(store.loaded).toBe(false)
    expect(store.loading).toBe(false)
  })

  it('refresh clears the previous error before fetching', async () => {
    const store = useAssetsListStore()
    let shouldFail = true
    store.configure({
      loadList: async () => {
        if (shouldFail) throw new Error('first')
        return [sampleSummary()]
      },
    })

    await store.refresh()
    expect(store.error).toBe('first')

    shouldFail = false
    await store.refresh()
    expect(store.error).toBeNull()
    expect(store.count).toBe(1)
  })

  it('invalidate drops the cache and resets loaded state', async () => {
    const store = useAssetsListStore()
    store.configure({ loadList: async () => [sampleSummary()] })
    await store.refresh()
    expect(store.count).toBe(1)

    store.invalidate()

    expect(store.assets).toEqual([])
    expect(store.loaded).toBe(false)
    expect(store.error).toBeNull()
  })
})
