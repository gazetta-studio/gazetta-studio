/**
 * ArchiveModal capability-gap note: the per-target warning links to the
 * runtime capabilities doc.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import PrimeVue from 'primevue/config'
import ArchiveModal from '../src/client/components/ArchiveModal.vue'
import { useArchiveStore } from '../src/client/stores/archive.js'
import { api, type TargetInfo } from '../src/client/api/client.js'

beforeAll(() => {
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
        onchange: null,
      }) as unknown as MediaQueryList
  }
})

const plainStatic: TargetInfo = {
  name: 'production-static',
  environment: 'production',
  type: 'static',
  editable: false,
  altText: { available: false, auto: false },
  capabilities: {
    has: [],
    gaps: [{ capability: 'redirects', reason: 'plain-static target has no worker' }],
  },
}

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ''
})

describe('ArchiveModal — capability-gap note', () => {
  it('links to the runtime capabilities doc on GitHub', async () => {
    vi.spyOn(api, 'getTargets').mockResolvedValue([plainStatic])
    const wrapper = mount(ArchiveModal, { attachTo: document.body, global: { plugins: [PrimeVue] } })
    useArchiveStore().askArchive({ kind: 'page', name: 'landing', archived: false })
    await flushPromises()
    await wrapper.vm.$nextTick()

    const link = document.querySelector('.archive-gaps-note a') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe(
      'https://github.com/gazetta-studio/gazetta-studio/blob/main/docs/runtime-capabilities.md',
    )

    wrapper.unmount()
  })
})
