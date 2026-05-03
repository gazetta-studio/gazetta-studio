/**
 * Unit tests for the sync-status store.
 *
 * Dependencies are injected via configure(): compareFn, listTargets,
 * activeTarget. No module mocks.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { TargetInfo, CompareResult } from '../src/client/api/client.js'
import { useSyncStatusStore, type CompareFn } from '../src/client/stores/syncStatus.js'

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

const EMPTY_RESULT: CompareResult = {
  added: [],
  modified: [],
  deleted: [],
  unchanged: [],
  firstPublish: false,
  invalidTemplates: [],
}

function mkResult(over: Partial<CompareResult>): CompareResult {
  return { ...EMPTY_RESULT, ...over }
}

function fixedCompare(results: Record<string, CompareResult>): CompareFn {
  return async target => {
    if (!(target in results)) throw new Error(`No result fixture for target: ${target}`)
    return results[target]
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('useSyncStatusStore', () => {
  it('nonActiveTargets excludes the active target', () => {
    const store = useSyncStatusStore()
    store.configure({
      listTargets: () => TARGETS,
      activeTarget: () => 'local',
    })
    expect(store.nonActiveTargets.map(t => t.name)).toEqual(['staging', 'prod'])
  })

  it('refreshOne stores the summarized status', async () => {
    const store = useSyncStatusStore()
    store.configure({
      compareFn: fixedCompare({
        staging: mkResult({ added: ['pages/home'], modified: ['pages/about'], firstPublish: false }),
      }),
      listTargets: () => TARGETS,
      activeTarget: () => 'local',
    })
    await store.refreshOne('staging')
    const status = store.get('staging')
    expect(status).not.toBeNull()
    expect(status!.changedCount).toBe(2)
    expect(status!.firstPublish).toBe(false)
  })

  it('refreshOne records first-publish state', async () => {
    const store = useSyncStatusStore()
    store.configure({
      compareFn: fixedCompare({
        staging: mkResult({ added: ['pages/home', 'pages/about'], firstPublish: true }),
      }),
      listTargets: () => TARGETS,
      activeTarget: () => 'local',
    })
    await store.refreshOne('staging')
    expect(store.get('staging')?.firstPublish).toBe(true)
  })

  it('refreshAll compares every non-active target', async () => {
    const compareFn = vi.fn<CompareFn>(async target => mkResult({ added: [`${target}-change`] }))
    const store = useSyncStatusStore()
    store.configure({
      compareFn,
      listTargets: () => TARGETS,
      activeTarget: () => 'local',
    })
    await store.refreshAll()
    expect(compareFn).toHaveBeenCalledTimes(2)
    expect(compareFn).toHaveBeenCalledWith('staging')
    expect(compareFn).toHaveBeenCalledWith('prod')
    expect(compareFn).not.toHaveBeenCalledWith('local')
  })

  it('stores errors without throwing when compare fails', async () => {
    const store = useSyncStatusStore()
    store.configure({
      compareFn: async () => {
        throw new Error('network down')
      },
      listTargets: () => TARGETS,
      activeTarget: () => 'local',
    })
    await store.refreshOne('staging')
    expect(store.errorFor('staging')).toBe('network down')
    expect(store.get('staging')).toBeNull()
  })

  it('tracks in-flight loading per target', async () => {
    let release!: () => void
    const pending = new Promise<CompareResult>(r => {
      release = () => r(EMPTY_RESULT)
    })
    const store = useSyncStatusStore()
    store.configure({
      compareFn: () => pending,
      listTargets: () => TARGETS,
      activeTarget: () => 'local',
    })
    const p = store.refreshOne('staging')
    expect(store.isLoading('staging')).toBe(true)
    release()
    await p
    expect(store.isLoading('staging')).toBe(false)
  })

  it('invalidate() drops the stored status and error for one target', async () => {
    const store = useSyncStatusStore()
    store.configure({
      compareFn: fixedCompare({ staging: mkResult({ added: ['a'] }) }),
      listTargets: () => TARGETS,
      activeTarget: () => 'local',
    })
    await store.refreshOne('staging')
    expect(store.get('staging')).not.toBeNull()
    store.invalidate('staging')
    expect(store.get('staging')).toBeNull()
  })

  it('clear() resets all state', async () => {
    const store = useSyncStatusStore()
    store.configure({
      compareFn: fixedCompare({ staging: mkResult({ added: ['a'] }), prod: mkResult({ modified: ['b'] }) }),
      listTargets: () => TARGETS,
      activeTarget: () => 'local',
    })
    await store.refreshAll()
    expect(store.statuses.size).toBe(2)
    store.clear()
    expect(store.statuses.size).toBe(0)
    expect(store.errors.size).toBe(0)
    expect(store.loading.size).toBe(0)
  })
})
