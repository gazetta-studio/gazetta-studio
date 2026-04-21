import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAssetsSelectionStore } from '../src/client/stores/assetsSelection.js'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('assetsSelection store', () => {
  it('starts with no selection', () => {
    const store = useAssetsSelectionStore()
    expect(store.selectedName).toBeNull()
    expect(store.isSelected('anything')).toBe(false)
  })

  it('select sets the selected name', () => {
    const store = useAssetsSelectionStore()
    store.select('hero')
    expect(store.selectedName).toBe('hero')
    expect(store.isSelected('hero')).toBe(true)
    expect(store.isSelected('other')).toBe(false)
  })

  it('selecting another name replaces the previous selection (single-select)', () => {
    const store = useAssetsSelectionStore()
    store.select('hero')
    store.select('banner')
    expect(store.selectedName).toBe('banner')
    expect(store.isSelected('hero')).toBe(false)
    expect(store.isSelected('banner')).toBe(true)
  })

  it('clear removes the selection', () => {
    const store = useAssetsSelectionStore()
    store.select('hero')
    store.clear()
    expect(store.selectedName).toBeNull()
    expect(store.isSelected('hero')).toBe(false)
  })
})
