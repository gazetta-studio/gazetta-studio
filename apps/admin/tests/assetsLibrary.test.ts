import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAssetsLibraryStore } from '../src/client/stores/assetsLibrary.js'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('assetsLibrary store', () => {
  it('starts closed', () => {
    const store = useAssetsLibraryStore()
    expect(store.isOpen).toBe(false)
  })

  it('open() makes isOpen true', () => {
    const store = useAssetsLibraryStore()
    store.open()
    expect(store.isOpen).toBe(true)
  })

  it('close() makes isOpen false', () => {
    const store = useAssetsLibraryStore()
    store.open()
    store.close()
    expect(store.isOpen).toBe(false)
  })

  it('toggle() flips the state', () => {
    const store = useAssetsLibraryStore()
    expect(store.isOpen).toBe(false)
    store.toggle()
    expect(store.isOpen).toBe(true)
    store.toggle()
    expect(store.isOpen).toBe(false)
  })

  it('open() is idempotent', () => {
    const store = useAssetsLibraryStore()
    store.open()
    store.open()
    expect(store.isOpen).toBe(true)
  })
})
