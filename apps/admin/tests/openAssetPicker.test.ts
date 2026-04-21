import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { openAssetPicker } from '../src/client/api/openAssetPicker.js'
import { useAssetsPickerStore } from '../src/client/stores/assetsPicker.js'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('openAssetPicker', () => {
  it('opens the picker store and returns a pending promise', async () => {
    const store = useAssetsPickerStore()
    const promise = openAssetPicker({ accept: ['image'] })

    expect(store.isOpen).toBe(true)
    expect(store.accept).toEqual(['image'])

    // Resolve via store.confirm — promise should settle.
    store.confirm('hero')
    const result = await promise
    expect(result).toEqual({ _asset: 'hero' })
  })

  it('resolves with null when the user cancels', async () => {
    const store = useAssetsPickerStore()
    const promise = openAssetPicker()

    store.cancel()
    expect(await promise).toBeNull()
  })

  it('passes currentAssetName through to the store', () => {
    const store = useAssetsPickerStore()
    openAssetPicker({ accept: ['image'], currentAssetName: 'existing' })
    expect(store.currentAssetName).toBe('existing')
  })

  it('handles no-options call (defaults to no filter)', async () => {
    const store = useAssetsPickerStore()
    const promise = openAssetPicker()
    expect(store.accept).toEqual([])
    store.cancel()
    expect(await promise).toBeNull()
  })
})
