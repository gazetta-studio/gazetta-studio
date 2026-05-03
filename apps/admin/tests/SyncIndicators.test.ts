/**
 * Component tests for SyncIndicators.vue.
 *
 * Uses real Pinia stores with configure()-injected dependencies — matches
 * the repo idiom (see syncStatus.test.ts, activeTarget.test.ts). No
 * @pinia/testing, no module mocks.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SyncIndicators from '../src/client/components/SyncIndicators.vue'
import { useSyncStatusStore } from '../src/client/stores/syncStatus.js'
import { useActiveTargetStore } from '../src/client/stores/activeTarget.js'
import type { TargetInfo, CompareResult } from '../src/client/api/client.js'

const EMPTY_RESULT: CompareResult = {
  added: [],
  modified: [],
  deleted: [],
  unchanged: [],
  firstPublish: false,
  invalidTemplates: [],
}

function mkResult(over: Partial<CompareResult> = {}): CompareResult {
  return { ...EMPTY_RESULT, ...over }
}

/** Install the stores with injected targets + an active target name. */
function setupStores(targets: TargetInfo[], active: string) {
  const activeStore = useActiveTargetStore()
  activeStore.targets = targets
  activeStore.activeTargetName = active

  const syncStore = useSyncStatusStore()
  syncStore.configure({
    listTargets: () => targets,
    activeTarget: () => active,
    compareFn: async () => EMPTY_RESULT,
  })

  return { activeStore, syncStore }
}

describe('SyncIndicators', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('renders nothing when there are no non-active targets', () => {
    const targets: TargetInfo[] = [
      {
        name: 'local',
        environment: 'local',
        type: 'static',
        editable: true,
        altText: { available: false, auto: false },
      },
    ]
    setupStores(targets, 'local')
    const w = mount(SyncIndicators)
    expect(w.find('[data-testid="sync-indicators"]').exists()).toBe(false)
  })

  it('renders a chip for each non-active target (flat, ≤3 targets)', () => {
    const targets: TargetInfo[] = [
      {
        name: 'local',
        environment: 'local',
        type: 'static',
        editable: true,
        altText: { available: false, auto: false },
      },
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
    const { syncStore } = setupStores(targets, 'local')
    syncStore.statuses.set('staging', { changedCount: 3, firstPublish: false, result: mkResult() })
    syncStore.statuses.set('prod', { changedCount: 0, firstPublish: false, result: mkResult() })

    const w = mount(SyncIndicators)
    expect(w.find('[data-testid="sync-chip-staging"]').exists()).toBe(true)
    expect(w.find('[data-testid="sync-chip-prod"]').exists()).toBe(true)
    expect(w.find('[data-testid="sync-chip-local"]').exists()).toBe(false)
  })

  it('shows "N behind" for a target with changes', () => {
    const targets: TargetInfo[] = [
      {
        name: 'local',
        environment: 'local',
        type: 'static',
        editable: true,
        altText: { available: false, auto: false },
      },
      {
        name: 'staging',
        environment: 'staging',
        type: 'static',
        editable: false,
        altText: { available: false, auto: false },
      },
    ]
    const { syncStore } = setupStores(targets, 'local')
    syncStore.statuses.set('staging', { changedCount: 3, firstPublish: false, result: mkResult() })

    const w = mount(SyncIndicators)
    expect(w.find('[data-testid="sync-chip-staging"]').text()).toContain('3 behind')
  })

  it('shows "in sync" for a target with no changes', () => {
    const targets: TargetInfo[] = [
      {
        name: 'local',
        environment: 'local',
        type: 'static',
        editable: true,
        altText: { available: false, auto: false },
      },
      {
        name: 'staging',
        environment: 'staging',
        type: 'static',
        editable: false,
        altText: { available: false, auto: false },
      },
    ]
    const { syncStore } = setupStores(targets, 'local')
    syncStore.statuses.set('staging', { changedCount: 0, firstPublish: false, result: mkResult() })

    const w = mount(SyncIndicators)
    expect(w.find('[data-testid="sync-chip-staging"]').text()).toContain('in sync')
  })

  it('shows "not yet published" when firstPublish is true', () => {
    const targets: TargetInfo[] = [
      {
        name: 'local',
        environment: 'local',
        type: 'static',
        editable: true,
        altText: { available: false, auto: false },
      },
      {
        name: 'staging',
        environment: 'staging',
        type: 'static',
        editable: false,
        altText: { available: false, auto: false },
      },
    ]
    const { syncStore } = setupStores(targets, 'local')
    syncStore.statuses.set('staging', { changedCount: 0, firstPublish: true, result: mkResult({ firstPublish: true }) })

    const w = mount(SyncIndicators)
    expect(w.find('[data-testid="sync-chip-staging"]').text()).toContain('not yet published')
  })

  it('shows "…" while loading', () => {
    const targets: TargetInfo[] = [
      {
        name: 'local',
        environment: 'local',
        type: 'static',
        editable: true,
        altText: { available: false, auto: false },
      },
      {
        name: 'staging',
        environment: 'staging',
        type: 'static',
        editable: false,
        altText: { available: false, auto: false },
      },
    ]
    const { syncStore } = setupStores(targets, 'local')
    syncStore.loading.add('staging')

    const w = mount(SyncIndicators)
    expect(w.find('[data-testid="sync-chip-staging"]').text()).toContain('…')
  })

  it('shows "?" on error', () => {
    const targets: TargetInfo[] = [
      {
        name: 'local',
        environment: 'local',
        type: 'static',
        editable: true,
        altText: { available: false, auto: false },
      },
      {
        name: 'staging',
        environment: 'staging',
        type: 'static',
        editable: false,
        altText: { available: false, auto: false },
      },
    ]
    const { syncStore } = setupStores(targets, 'local')
    syncStore.errors.set('staging', 'network error')

    const w = mount(SyncIndicators)
    expect(w.find('[data-testid="sync-chip-staging"]').text()).toContain('?')
  })

  it('applies env-production class to production targets', () => {
    const targets: TargetInfo[] = [
      {
        name: 'local',
        environment: 'local',
        type: 'static',
        editable: true,
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
    const { syncStore } = setupStores(targets, 'local')
    syncStore.statuses.set('prod', { changedCount: 0, firstPublish: false, result: mkResult() })

    const w = mount(SyncIndicators)
    expect(w.find('[data-testid="sync-chip-prod"]').classes()).toContain('env-production')
  })

  it('emits select with target name on chip click', async () => {
    const targets: TargetInfo[] = [
      {
        name: 'local',
        environment: 'local',
        type: 'static',
        editable: true,
        altText: { available: false, auto: false },
      },
      {
        name: 'staging',
        environment: 'staging',
        type: 'static',
        editable: false,
        altText: { available: false, auto: false },
      },
    ]
    const { syncStore } = setupStores(targets, 'local')
    syncStore.statuses.set('staging', { changedCount: 1, firstPublish: false, result: mkResult() })

    const w = mount(SyncIndicators)
    await w.find('[data-testid="sync-chip-staging"]').trigger('click')
    expect(w.emitted('select')).toEqual([['staging']])
  })

  describe('grouping at 4+ targets', () => {
    const fourTargets: TargetInfo[] = [
      {
        name: 'local',
        environment: 'local',
        type: 'static',
        editable: true,
        altText: { available: false, auto: false },
      },
      {
        name: 'staging',
        environment: 'staging',
        type: 'static',
        editable: false,
        altText: { available: false, auto: false },
      },
      {
        name: 'prod-us',
        environment: 'production',
        type: 'static',
        editable: false,
        altText: { available: false, auto: false },
      },
      {
        name: 'prod-eu',
        environment: 'production',
        type: 'static',
        editable: false,
        altText: { available: false, auto: false },
      },
    ]

    it('collapses same-environment targets into a group chip', () => {
      const { syncStore } = setupStores(fourTargets, 'local')
      syncStore.statuses.set('staging', { changedCount: 0, firstPublish: false, result: mkResult() })
      syncStore.statuses.set('prod-us', { changedCount: 2, firstPublish: false, result: mkResult() })
      syncStore.statuses.set('prod-eu', { changedCount: 5, firstPublish: false, result: mkResult() })

      const w = mount(SyncIndicators)
      expect(w.find('[data-testid="sync-chip-group-production"]').exists()).toBe(true)
      // Group aggregates: 2 + 5 = 7 behind
      expect(w.find('[data-testid="sync-chip-group-production"]').text()).toContain('7 behind')
      // Individual chips for group members should be hidden until expanded
      expect(w.find('[data-testid="sync-chip-prod-us"]').exists()).toBe(false)
    })

    it('keeps single-member environments flat even at 4+ total', () => {
      const { syncStore } = setupStores(fourTargets, 'local')
      syncStore.statuses.set('staging', { changedCount: 0, firstPublish: false, result: mkResult() })

      const w = mount(SyncIndicators)
      // staging is alone in its environment → flat chip, not a group
      expect(w.find('[data-testid="sync-chip-staging"]').exists()).toBe(true)
      expect(w.find('[data-testid="sync-chip-group-staging"]').exists()).toBe(false)
    })

    it('expands a group to reveal member chips on click', async () => {
      const { syncStore } = setupStores(fourTargets, 'local')
      syncStore.statuses.set('prod-us', { changedCount: 2, firstPublish: false, result: mkResult() })
      syncStore.statuses.set('prod-eu', { changedCount: 5, firstPublish: false, result: mkResult() })

      const w = mount(SyncIndicators)
      await w.find('[data-testid="sync-chip-group-production"]').trigger('click')

      expect(w.find('[data-testid="sync-chip-prod-us"]').exists()).toBe(true)
      expect(w.find('[data-testid="sync-chip-prod-eu"]').exists()).toBe(true)
      expect(w.find('[data-testid="sync-chip-group-production"]').attributes('aria-expanded')).toBe('true')
    })
  })
})
