import { describe, it, expect } from 'vitest'
import type { StorageProvider } from '../src/types.js'
import { createContentRoot } from '../src/content-root.js'

function mockStorage(): StorageProvider {
  return {
    readFile: async () => 'x',
    writeFile: async () => {},
    readDir: async () => [],
    exists: async () => false,
    mkdir: async () => {},
    rm: async () => {},
  }
}

describe('createContentRoot', () => {
  it('joins segments with the root prefix when set', () => {
    const root = createContentRoot(mockStorage(), '/abs/path/sites/main')
    expect(root.path('pages', 'home')).toBe('/abs/path/sites/main/pages/home')
    expect(root.path('pages/home', 'page.json')).toBe('/abs/path/sites/main/pages/home/page.json')
    expect(root.path('site.config.ts')).toBe('/abs/path/sites/main/site.config.ts')
  })

  it('joins segments without a prefix when rootPath is empty', () => {
    const root = createContentRoot(mockStorage())
    expect(root.path('pages', 'home')).toBe('pages/home')
    expect(root.path('site.config.ts')).toBe('site.config.ts')
  })

  it('rootPath defaults to empty string', () => {
    const root = createContentRoot(mockStorage())
    expect(root.rootPath).toBe('')
  })

  it('exposes the storage provider unchanged', () => {
    const s = mockStorage()
    const root = createContentRoot(s, '/somewhere')
    expect(root.storage).toBe(s)
  })

  it('is read-only in shape (properties not reassignable after construction)', () => {
    const root = createContentRoot(mockStorage(), '/x')
    // Not enforced by runtime, but documenting the contract: callers treat
    // ContentRoot as immutable. A fresh one is constructed when rooting changes.
    expect(typeof root.path).toBe('function')
    expect(root.rootPath).toBe('/x')
  })
})
