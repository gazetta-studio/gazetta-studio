import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAssetsPickerStore } from '../src/client/stores/assetsPicker.js'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('useAssetsPickerStore', () => {
  it('starts closed with no accept filter', () => {
    const store = useAssetsPickerStore()
    expect(store.isOpen).toBe(false)
    expect(store.accept).toEqual([])
    expect(store.currentAssetName).toBeNull()
  })

  it('open() sets accept, currentAssetName, and isOpen', () => {
    const store = useAssetsPickerStore()
    store.open({ accept: ['image'], currentAssetName: 'hero' }, () => {})
    expect(store.isOpen).toBe(true)
    expect(store.accept).toEqual(['image'])
    expect(store.currentAssetName).toBe('hero')
  })

  it('open() defaults to empty accept and null currentAssetName when options omitted', () => {
    const store = useAssetsPickerStore()
    store.open({}, () => {})
    expect(store.accept).toEqual([])
    expect(store.currentAssetName).toBeNull()
  })

  it('confirm() fires the resolver with { _asset } and closes', () => {
    const store = useAssetsPickerStore()
    const resolver = vi.fn()
    store.open({}, resolver)

    store.confirm('hero')

    expect(resolver).toHaveBeenCalledWith({ _asset: 'hero' })
    expect(store.isOpen).toBe(false)
  })

  it('cancel() fires the resolver with null and closes', () => {
    const store = useAssetsPickerStore()
    const resolver = vi.fn()
    store.open({}, resolver)

    store.cancel()

    expect(resolver).toHaveBeenCalledWith(null)
    expect(store.isOpen).toBe(false)
  })

  it('confirm() is a no-op when no picker is open', () => {
    const store = useAssetsPickerStore()
    // Nothing to assert beyond "doesn't throw" — the resolver is null.
    expect(() => store.confirm('hero')).not.toThrow()
    expect(store.isOpen).toBe(false)
  })

  it('cancel() is a no-op when no picker is open', () => {
    const store = useAssetsPickerStore()
    expect(() => store.cancel()).not.toThrow()
    expect(store.isOpen).toBe(false)
  })

  it('opening a second picker cancels the first (fires previous resolver with null)', () => {
    const store = useAssetsPickerStore()
    const first = vi.fn()
    const second = vi.fn()

    store.open({ accept: ['image'] }, first)
    store.open({ accept: ['pdf'] }, second)

    expect(first).toHaveBeenCalledWith(null)
    expect(second).not.toHaveBeenCalled()
    expect(store.accept).toEqual(['pdf'])
    expect(store.isOpen).toBe(true)
  })

  it('confirm() fires the resolver at most once (idempotent close)', () => {
    const store = useAssetsPickerStore()
    const resolver = vi.fn()
    store.open({}, resolver)

    store.confirm('hero')
    store.confirm('other')
    store.cancel()

    expect(resolver).toHaveBeenCalledTimes(1)
    expect(resolver).toHaveBeenCalledWith({ _asset: 'hero' })
  })

  it('cancel() fires the resolver at most once', () => {
    const store = useAssetsPickerStore()
    const resolver = vi.fn()
    store.open({}, resolver)

    store.cancel()
    store.cancel()

    expect(resolver).toHaveBeenCalledTimes(1)
  })
})
