/**
 * HistoryPanel on a target whose storage is public: it keeps no history
 * (design-public-storage.md Q3), so the panel says so, names the private
 * target to restore on, and links to the capabilities view, instead of
 * asking for revisions the server would refuse.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import HistoryPanel from '../src/client/components/HistoryPanel.vue'
import { useActiveTargetStore } from '../src/client/stores/activeTarget.js'
import { HISTORY_API, type HistoryApi } from '../src/client/composables/api.js'
import type { TargetInfo } from '../src/client/api/client.js'

function targetInfo(name: string, publicStorage: boolean, auditHome: TargetInfo['auditHome']): TargetInfo {
  return {
    name,
    environment: publicStorage ? 'production' : 'local',
    type: 'static',
    editable: !publicStorage,
    altText: { available: false, auto: false },
    capabilities: { has: [], gaps: [] },
    publicStorage,
    auditHome,
    about: [],
  }
}

let listHistory: ReturnType<typeof vi.fn>

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ''
  listHistory = vi.fn(async () => ({ revisions: [] }))
})

async function open(active: string, productionAudit: TargetInfo['auditHome'] = { kind: 'target', name: 'local' }) {
  const store = useActiveTargetStore()
  store.targets = [targetInfo('local', false, { kind: 'self' }), targetInfo('production', true, productionAudit)]
  store.activeTargetName = active
  const historyApi: HistoryApi = {
    listHistory,
    undoLastWrite: vi.fn(),
    restoreRevision: vi.fn(),
  }
  const w = mount(HistoryPanel, {
    props: { visible: false },
    attachTo: document.body,
    global: { provide: { [HISTORY_API as symbol]: historyApi } },
  })
  await w.setProps({ visible: true })
  await flushPromises()
  return w
}

const line = () => document.querySelector('[data-testid="history-public-storage"]')

describe('HistoryPanel on public storage', () => {
  it('says the target keeps no history and names the target to restore on', async () => {
    await open('production')
    const text = line()?.textContent?.replace(/\s+/g, ' ').trim()
    expect(text).toContain("This target doesn't keep history because its storage is public.")
    expect(text).toContain('To roll back, restore the page on local and publish it again.')
    expect(line()?.querySelector('code')?.textContent).toBe('local')
    expect(listHistory).not.toHaveBeenCalled()
  })

  it('names no target to restore on when no target keeps audit', async () => {
    await open('production', { kind: 'none' })
    const text = line()?.textContent?.replace(/\s+/g, ' ').trim()
    expect(text).toContain("This target doesn't keep history because its storage is public.")
    expect(text).not.toContain('To roll back')
    expect(line()?.querySelector('code')).toBeNull()
  })

  it('its link asks to open the capabilities view', async () => {
    const w = await open('production')
    ;(document.querySelector('[data-testid="history-public-storage-about"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(w.emitted('open-capabilities')).toHaveLength(1)
  })

  it('is absent on a private target, which lists its revisions', async () => {
    await open('local')
    expect(line()).toBeNull()
    expect(listHistory).toHaveBeenCalledWith('local')
    expect(document.querySelector('[data-testid="history-empty"]')).not.toBeNull()
  })

  it('waits for the target list before asking for revisions', async () => {
    const store = useActiveTargetStore()
    store.activeTargetName = 'production'
    const historyApi: HistoryApi = { listHistory, undoLastWrite: vi.fn(), restoreRevision: vi.fn() }
    const w = mount(HistoryPanel, {
      props: { visible: false },
      attachTo: document.body,
      global: { provide: { [HISTORY_API as symbol]: historyApi } },
    })
    await w.setProps({ visible: true })
    await flushPromises()
    expect(listHistory).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="history-error"]')).toBeNull()

    store.targets = [
      targetInfo('local', false, { kind: 'self' }),
      targetInfo('production', true, { kind: 'target', name: 'local' }),
    ]
    await flushPromises()
    expect(listHistory).not.toHaveBeenCalled()
    expect(line()).not.toBeNull()
  })
})
