/**
 * Component tests for PublishPanel.vue — the unified Publish surface
 * that absorbed PublishDialog + FetchDialog + ChangesDrawer.
 *
 * Scope: source picking, destination rendering (flat vs grouped),
 * production confirmation, publish dispatch, undo dispatch, results
 * rendering, publish label computation.
 *
 * Uses the composable DI from #149: PublishApi and HistoryApi injected
 * via `global.provide`; no module mocks.
 *
 * PublishItemList (child) is stubbed — it has its own API surface and
 * deserves its own tests. The parent's interaction with it is via
 * v-model:selected, which we simulate by setting store state.
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import PrimeVue from 'primevue/config'
import PublishPanel from '../src/client/components/PublishPanel.vue'
import { PUBLISH_API, HISTORY_API, type PublishApi, type HistoryApi } from '../src/client/composables/api.js'
import { useActiveTargetStore } from '../src/client/stores/activeTarget.js'
import { useSyncStatusStore } from '../src/client/stores/syncStatus.js'
import type { TargetInfo, PublishResult, PublishProgress } from '../src/client/api/client.js'

// PrimeVue's Select uses window.matchMedia for orientation detection;
// jsdom doesn't implement it. Stub once globally.
beforeAll(() => {
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList
  }
})

function fakePublishApi(partial: Partial<PublishApi> = {}): PublishApi {
  const notImplemented = (name: string) => () => {
    throw new Error(`fakePublishApi.${name} not stubbed`)
  }
  return {
    publish: notImplemented('publish'),
    publishStream: notImplemented('publishStream'),
    compare: notImplemented('compare'),
    fetchFromTarget: notImplemented('fetchFromTarget'),
    ...partial,
  } as PublishApi
}

function fakeHistoryApi(partial: Partial<HistoryApi> = {}): HistoryApi {
  const notImplemented = (name: string) => () => {
    throw new Error(`fakeHistoryApi.${name} not stubbed`)
  }
  return {
    listHistory: notImplemented('listHistory'),
    undoLastWrite: notImplemented('undoLastWrite'),
    restoreRevision: notImplemented('restoreRevision'),
    ...partial,
  } as HistoryApi
}

function installTargets(targets: TargetInfo[], active: string) {
  const active$ = useActiveTargetStore()
  active$.targets = targets
  active$.activeTargetName = active
  const sync$ = useSyncStatusStore()
  sync$.configure({
    listTargets: () => targets,
    activeTarget: () => active,
    compareFn: async () => ({
      added: [],
      modified: [],
      deleted: [],
      unchanged: [],
      firstPublish: false,
      invalidTemplates: [],
    }),
  })
}

async function mountPanel(
  opts: { publishApi?: PublishApi; historyApi?: HistoryApi; initialDestination?: string } = {},
): Promise<VueWrapper> {
  const w = mount(PublishPanel, {
    attachTo: document.body,
    // Mount with visible:false and flip to true to trigger the init watcher
    // (which only fires on change, not initial mount).
    props: { visible: false, initialDestination: opts.initialDestination },
    global: {
      plugins: [PrimeVue],
      provide: {
        [PUBLISH_API as symbol]: opts.publishApi ?? fakePublishApi(),
        [HISTORY_API as symbol]: opts.historyApi ?? fakeHistoryApi(),
      },
      stubs: {
        // PublishItemList has its own api surface; stub to control selected items
        // via the panel's v-model plumbing. Emit 'update:selected' from tests
        // when we want to simulate item selection.
        PublishItemList: {
          name: 'PublishItemList',
          props: ['source', 'destinations', 'selected'],
          emits: ['update:selected'],
          template: '<div data-testid="publish-item-list-stub" />',
        },
      },
    },
  })
  await w.setProps({ visible: true })
  await flushMicrotasks()
  return w
}

/**
 * PrimeVue's Dialog uses Teleport to body. Queries through the wrapper
 * don't reach the teleported content, so we query document directly.
 */
function q(selector: string): Element | null {
  return document.querySelector(selector)
}
function qAll(selector: string): Element[] {
  return Array.from(document.querySelectorAll(selector))
}
function qExists(testid: string): boolean {
  return q(`[data-testid="${testid}"]`) !== null
}
function qText(testid: string): string {
  return q(`[data-testid="${testid}"]`)?.textContent?.trim() ?? ''
}

/**
 * Set `selectedItems` on the panel by emitting from the stubbed PublishItemList.
 * Simulates what the real list does when the user picks items.
 */
async function pickItems(w: VueWrapper, items: string[]) {
  const list = w.findComponent({ name: 'PublishItemList' })
  list.vm.$emit('update:selected', new Set(items))
  await w.vm.$nextTick()
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
}

describe('PublishPanel', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    document.body.innerHTML = ''
  })

  describe('source picker', () => {
    it('shows a fixed source chip when only one editable target exists', async () => {
      installTargets(
        [
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
        ],
        'local',
      )
      await mountPanel()
      await flushMicrotasks()
      expect(qExists('publish-source-fixed')).toBe(true)
      expect(qExists('publish-source-select')).toBe(false)
      expect(qText('publish-source-fixed')).toContain('local')
    })

    it('shows a dropdown when 2+ editable targets exist', async () => {
      installTargets(
        [
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
        ],
        'local',
      )
      await mountPanel()
      await flushMicrotasks()
      expect(qExists('publish-source-select')).toBe(true)
      expect(qExists('publish-source-fixed')).toBe(false)
    })

    it('defaults source to the active target when it is editable', async () => {
      installTargets(
        [
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
            editable: true,
            altText: { available: false, auto: false },
          },
        ],
        'staging',
      )
      const w = await mountPanel()
      await flushMicrotasks()
      const select = w.findComponent({ name: 'Select' })
      expect(select.exists()).toBe(true)
      expect(select.props('modelValue')).toBe('staging')
    })

    it('defaults source to the first editable when active is read-only', async () => {
      installTargets(
        [
          {
            name: 'staging',
            environment: 'staging',
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
        ],
        'prod',
      )
      await mountPanel()
      await flushMicrotasks()
      // Only one editable target → fixed chip shows 'staging'
      expect(qText('publish-source-fixed')).toContain('staging')
    })
  })

  describe('destinations', () => {
    it('renders one chip per non-source target (flat ≤3)', async () => {
      installTargets(
        [
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
        ],
        'local',
      )
      await mountPanel()
      await flushMicrotasks()
      // Source (local) is NOT in the destination list
      expect(qExists('publish-dest-local')).toBe(false)
      expect(qExists('publish-dest-staging')).toBe(true)
      expect(qExists('publish-dest-prod')).toBe(true)
    })

    it('shows a group header for same-environment members at 4+ total', async () => {
      installTargets(
        [
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
        ],
        'local',
      )
      await mountPanel()
      await flushMicrotasks()
      expect(qExists('publish-dest-group-production')).toBe(true)
      expect(qExists('publish-dest-prod-us')).toBe(true)
      expect(qExists('publish-dest-prod-eu')).toBe(true)
    })

    it('preselects initialDestination when provided', async () => {
      installTargets(
        [
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
        ],
        'local',
      )
      const w = await mountPanel({ initialDestination: 'staging' })
      await flushMicrotasks()
      await pickItems(w, ['pages/home'])
      expect(qText('publish-panel-confirm')).toContain('1 target')
    })

    it('shows read-only badge on non-editable destinations', async () => {
      installTargets(
        [
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
        ],
        'local',
      )
      await mountPanel()
      await flushMicrotasks()
      expect(qText('publish-dest-prod')).toContain('read-only')
    })
  })

  describe('publish action', () => {
    it('disables the publish button until source + destinations + items are all set', async () => {
      installTargets(
        [
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
        ],
        'local',
      )
      await mountPanel()
      await flushMicrotasks()
      const btn = q('[data-testid="publish-panel-confirm"]') as HTMLButtonElement
      expect(btn.disabled).toBe(true)
    })

    it('computes label as "Publish N items → M targets"', async () => {
      installTargets(
        [
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
        ],
        'local',
      )
      const w = await mountPanel({ initialDestination: 'staging' })
      await flushMicrotasks()
      await pickItems(w, ['pages/home', 'pages/about'])
      expect(qText('publish-panel-confirm')).toContain('Publish 2 items → 1 target')
    })

    it('calls publishApi.publishStream on publish, with items + destinations + source', async () => {
      installTargets(
        [
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
        ],
        'local',
      )
      const publishStream = vi.fn(
        async (
          _items: string[],
          _targets: string[],
          onProgress: (ev: PublishProgress) => void,
          _opts?: { source?: string },
        ): Promise<PublishResult[]> => {
          onProgress({ kind: 'target-start', target: 'staging', total: 2 })
          onProgress({ kind: 'target-result', result: { target: 'staging', success: true, copiedFiles: 2 } })
          return [{ target: 'staging', success: true, copiedFiles: 2 }]
        },
      )
      const w = await mountPanel({ publishApi: fakePublishApi({ publishStream }), initialDestination: 'staging' })
      await flushMicrotasks()
      await pickItems(w, ['pages/home', 'pages/about'])

      ;(q('[data-testid="publish-panel-confirm"]') as HTMLElement).click()
      await flushMicrotasks()

      expect(publishStream).toHaveBeenCalledTimes(1)
      const [items, targets, , options] = publishStream.mock.calls[0]
      expect(items).toEqual(['pages/home', 'pages/about'])
      expect(targets).toEqual(['staging'])
      expect(options?.source).toBe('local')
    })

    it('shows results with per-target success + undo button after a successful publish', async () => {
      installTargets(
        [
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
        ],
        'local',
      )
      const publishStream = vi.fn(
        async (): Promise<PublishResult[]> => [{ target: 'staging', success: true, copiedFiles: 3 }],
      )
      const w = await mountPanel({ publishApi: fakePublishApi({ publishStream }), initialDestination: 'staging' })
      await flushMicrotasks()
      await pickItems(w, ['pages/home'])

      ;(q('[data-testid="publish-panel-confirm"]') as HTMLElement).click()
      await flushMicrotasks()
      await flushMicrotasks()

      expect(qExists('publish-result-staging')).toBe(true)
      expect(qText('publish-result-staging')).toContain('3 files')
      expect(qExists('publish-result-undo-staging')).toBe(true)
    })
  })

  describe('production confirmation', () => {
    it('requires explicit confirmation when a production destination is selected', async () => {
      installTargets(
        [
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
        ],
        'local',
      )
      const publishStream = vi.fn(async (): Promise<PublishResult[]> => [])
      const w = await mountPanel({ publishApi: fakePublishApi({ publishStream }), initialDestination: 'prod' })
      await flushMicrotasks()
      await pickItems(w, ['pages/home'])

      // First click enters confirm mode, does not yet publish
      ;(q('[data-testid="publish-panel-confirm"]') as HTMLElement).click()
      await flushMicrotasks()
      expect(publishStream).not.toHaveBeenCalled()
      expect(qExists('publish-confirm-banner')).toBe(true)
      expect(qExists('publish-panel-confirm-prod')).toBe(true)

      // Second click (on the prod-specific confirm button) runs the publish
      ;(q('[data-testid="publish-panel-confirm-prod"]') as HTMLElement).click()
      await flushMicrotasks()
      expect(publishStream).toHaveBeenCalledTimes(1)
    })

    it('skips confirmation when no production destination is selected', async () => {
      installTargets(
        [
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
        ],
        'local',
      )
      const publishStream = vi.fn(
        async (): Promise<PublishResult[]> => [{ target: 'staging', success: true, copiedFiles: 1 }],
      )
      const w = await mountPanel({ publishApi: fakePublishApi({ publishStream }), initialDestination: 'staging' })
      await flushMicrotasks()
      await pickItems(w, ['pages/home'])
      ;(q('[data-testid="publish-panel-confirm"]') as HTMLElement).click()
      await flushMicrotasks()
      expect(publishStream).toHaveBeenCalledTimes(1)
      expect(qExists('publish-confirm-banner')).toBe(false)
    })
  })

  describe('undo', () => {
    it('calls historyApi.undoLastWrite when result undo is clicked', async () => {
      installTargets(
        [
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
        ],
        'local',
      )
      const publishStream = vi.fn(
        async (): Promise<PublishResult[]> => [{ target: 'staging', success: true, copiedFiles: 1 }],
      )
      const undoLastWrite = vi.fn(async () => ({
        revision: { id: 'rev-1', timestamp: '2026-04-16T00:00:00Z', operation: 'rollback' as const, items: [] },
        restoredFrom: 'rev-0',
      }))
      const w = await mountPanel({
        publishApi: fakePublishApi({ publishStream }),
        historyApi: fakeHistoryApi({ undoLastWrite }),
        initialDestination: 'staging',
      })
      await flushMicrotasks()
      await pickItems(w, ['pages/home'])
      ;(q('[data-testid="publish-panel-confirm"]') as HTMLElement).click()
      await flushMicrotasks()
      await flushMicrotasks()

      ;(q('[data-testid="publish-result-undo-staging"]') as HTMLElement).click()
      await flushMicrotasks()

      expect(undoLastWrite).toHaveBeenCalledWith('staging')
      // After undo, the button label flips to "Undone" and disables
      const btn = q('[data-testid="publish-result-undo-staging"]') as HTMLButtonElement
      expect(btn.textContent?.trim()).toBe('Undone')
      expect(btn.disabled).toBe(true)
    })
  })
})
