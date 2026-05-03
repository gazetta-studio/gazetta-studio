/**
 * Unit tests for the active-target store.
 *
 * The store accepts an injected `loadTargets` dependency via `configure()`
 * — no module mocks, no global stubs needed. Target persistence is driven
 * by the URL query param (?target=), not localStorage.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { TargetInfo } from '../src/client/api/client.js'
import { useActiveTargetStore, type LoadTargets } from '../src/client/stores/activeTarget.js'

const TARGETS: TargetInfo[] = [
  { name: 'local', environment: 'local', type: 'static', editable: true, altText: { available: false, auto: false } },
  {
    name: 'staging',
    environment: 'staging',
    type: 'static',
    editable: false,
    altText: { available: false, auto: false },
  },
  {
    name: 'prod',
    environment: 'production',
    type: 'static',
    editable: false,
    altText: { available: false, auto: false },
  },
]

function fixedLoader(list: TargetInfo[]): LoadTargets {
  return async () => list
}

function failingLoader(message: string): LoadTargets {
  return async () => {
    throw new Error(message)
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('useActiveTargetStore', () => {
  it('picks the first editable target by default', async () => {
    const store = useActiveTargetStore()
    store.configure({ loadTargets: fixedLoader(TARGETS) })
    await store.load()
    expect(store.activeTargetName).toBe('local')
    expect(store.activeTarget?.environment).toBe('local')
  })

  it('falls back to the first target when none are editable', async () => {
    const readOnly: TargetInfo[] = [
      {
        name: 'staging',
        environment: 'staging',
        type: 'static',
        editable: false,
        altText: { available: false, auto: false },
      },
      {
        name: 'prod',
        environment: 'production',
        type: 'static',
        editable: false,
        altText: { available: false, auto: false },
      },
    ]
    const store = useActiveTargetStore()
    store.configure({ loadTargets: fixedLoader(readOnly) })
    await store.load()
    expect(store.activeTargetName).toBe('staging')
  })

  it('setActiveTarget updates the store', async () => {
    const store = useActiveTargetStore()
    store.configure({ loadTargets: fixedLoader(TARGETS) })
    await store.load()
    store.setActiveTarget('prod')
    expect(store.activeTargetName).toBe('prod')
  })

  it('setActiveTarget throws on unknown target', async () => {
    const store = useActiveTargetStore()
    store.configure({ loadTargets: fixedLoader(TARGETS) })
    await store.load()
    expect(() => store.setActiveTarget('missing')).toThrow(/Unknown target/)
  })

  it('isActiveEditable reflects the active target', async () => {
    const store = useActiveTargetStore()
    store.configure({ loadTargets: fixedLoader(TARGETS) })
    await store.load()
    expect(store.isActiveEditable).toBe(true)
    store.setActiveTarget('prod')
    expect(store.isActiveEditable).toBe(false)
  })

  it('editableTargets and readOnlyTargets partition the list', async () => {
    const store = useActiveTargetStore()
    store.configure({ loadTargets: fixedLoader(TARGETS) })
    await store.load()
    expect(store.editableTargets.map(t => t.name)).toEqual(['local'])
    expect(store.readOnlyTargets.map(t => t.name)).toEqual(['staging', 'prod'])
  })

  it('sets error and leaves state clean when loadTargets fails', async () => {
    const store = useActiveTargetStore()
    store.configure({ loadTargets: failingLoader('boom') })
    await store.load()
    expect(store.error).toBe('boom')
    expect(store.targets).toEqual([])
    expect(store.activeTargetName).toBe(null)
  })

  it('clear() resets state', async () => {
    const store = useActiveTargetStore()
    store.configure({ loadTargets: fixedLoader(TARGETS) })
    await store.load()
    expect(store.activeTargetName).toBe('local')
    store.clear()
    expect(store.targets).toEqual([])
    expect(store.activeTargetName).toBe(null)
    expect(store.error).toBe(null)
  })
})
