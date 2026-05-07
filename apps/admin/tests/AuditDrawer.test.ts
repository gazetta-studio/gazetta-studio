/**
 * Cut 6 component tests for AuditDrawer.vue.
 *
 * Pins the four UX states from design-audit.md "Audit drawer — query
 * semantics" + Krug-aligned absence-as-state rendering:
 *
 *   - state 1: history-only (events; no sink block)
 *   - state 2: history + external sinks with url (events + footer links)
 *   - state 3: external-only with url (no events; prominent message + link)
 *   - state 4: external-only without url (no events; "configure history" hint)
 *
 * Plus filter wiring + error state.
 *
 * PrimeVue Dialog teleports to document.body; queries go through
 * document.querySelector. `attachTo: document.body` + a per-test
 * `document.body.innerHTML = ''` reset matches the AssetDeleteConfirm
 * sibling test pattern.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import PrimeVue from 'primevue/config'
import AuditDrawer from '../src/client/components/AuditDrawer.vue'
import { AUDIT_API, type AuditApi } from '../src/client/composables/api.js'
import type { AuditEvent, AuditQueryFilter, AuditQueryResponse } from '../src/client/api/client.js'

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

function makeEvent(partial: Partial<AuditEvent> = {}): AuditEvent {
  return {
    timestamp: '2026-05-04T14:23:05Z',
    actor: { id: 'alice@example.com', email: 'alice@example.com', role: 'admin', trustMode: 'forwarded-user' },
    action: 'save',
    outcome: 'success',
    scope: { kind: 'page', name: 'home' },
    ...partial,
  }
}

function fakeAuditApi(response: AuditQueryResponse | (() => AuditQueryResponse)) {
  const calls: AuditQueryFilter[] = []
  const api: AuditApi = {
    async queryAudit(filter = {}) {
      calls.push(filter)
      return typeof response === 'function' ? response() : response
    },
  }
  return { api, calls }
}

function mountDrawer(api: AuditApi, visible = true) {
  return mount(AuditDrawer, {
    props: { visible },
    attachTo: document.body,
    global: {
      plugins: [PrimeVue],
      provide: { [AUDIT_API as symbol]: api },
    },
  })
}

function q(testid: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testid}"]`)
}

function qa(selector: string): HTMLElement[] {
  return Array.from(document.querySelectorAll(selector))
}

describe('AuditDrawer', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // PrimeVue's Dialog teleports into document.body; previous tests
    // leave its markup behind. Wipe so document.querySelector sees
    // only *this* test's render.
    document.body.innerHTML = ''
  })

  describe('state 1 — history-only', () => {
    it('renders inline events with no external-sink block', async () => {
      const { api } = fakeAuditApi({
        events: [
          makeEvent({ scope: { kind: 'page', name: 'home' } }),
          makeEvent({ scope: { kind: 'fragment', name: 'header' } }),
        ],
        externalSinks: [],
      })
      mountDrawer(api)
      await flushPromises()
      await flushPromises()
      expect(q('audit-events')).not.toBeNull()
      expect(qa('.event')).toHaveLength(2)
      expect(q('audit-footer-sinks')).toBeNull()
      expect(q('audit-external-with-link')).toBeNull()
      expect(q('audit-external-no-link')).toBeNull()
    })
  })

  describe('state 2 — history + external sinks with url', () => {
    it('renders events + footer "Also in" links', async () => {
      const { api } = fakeAuditApi({
        events: [makeEvent()],
        externalSinks: [
          { name: 'cloudwatch', url: 'https://aws.example.com/audit' },
          { name: 'splunk', url: 'https://splunk.example.com/search' },
        ],
      })
      mountDrawer(api)
      await flushPromises()
      expect(q('audit-events')).not.toBeNull()
      expect(q('audit-footer-sinks')).not.toBeNull()
      const cwLink = q('audit-sink-link-cloudwatch') as HTMLAnchorElement | null
      expect(cwLink).not.toBeNull()
      expect(cwLink!.getAttribute('href')).toBe('https://aws.example.com/audit')
      expect(q('audit-sink-link-splunk')).not.toBeNull()
    })
  })

  describe('state 3 — external-only with url', () => {
    it('renders prominent message + link, no inline events', async () => {
      const { api } = fakeAuditApi({
        events: [],
        externalSinks: [{ name: 'cloudwatch', url: 'https://aws.example.com/audit' }],
      })
      mountDrawer(api)
      await flushPromises()
      expect(q('audit-external-with-link')).not.toBeNull()
      expect(q('audit-events')).toBeNull()
      const link = q('audit-sink-link-cloudwatch') as HTMLAnchorElement | null
      expect(link).not.toBeNull()
      expect(link!.getAttribute('href')).toBe('https://aws.example.com/audit')
    })
  })

  describe('state 4 — external-only without url', () => {
    it('renders the "configure history" hint with provider names', async () => {
      const { api } = fakeAuditApi({
        events: [],
        externalSinks: [{ name: 'webhook', url: null }],
      })
      mountDrawer(api)
      await flushPromises()
      const block = q('audit-external-no-link')
      expect(block).not.toBeNull()
      expect(block!.textContent).toContain('webhook')
      expect(block!.textContent).toContain('history')
      expect(q('audit-events')).toBeNull()
    })
  })

  describe('empty state', () => {
    it('renders empty hint when no events + no sinks', async () => {
      const { api } = fakeAuditApi({ events: [], externalSinks: [] })
      mountDrawer(api)
      await flushPromises()
      expect(q('audit-empty')).not.toBeNull()
    })
  })

  describe('filter wiring', () => {
    it('passes typed filter values to the API', async () => {
      const { api, calls } = fakeAuditApi({ events: [], externalSinks: [] })
      const w = mountDrawer(api)
      await flushPromises()
      // Initial load, no filters.
      expect(calls.at(-1)).toEqual({})

      // Drive the filter refs directly — PrimeVue Select bindings
      // are an integration concern, the contract we're pinning is
      // "filter ref change → queryAudit fires with matching shape".
      const vm = w.vm as unknown as { filterAction: 'save' | 'publish' | null; filterActor: string }
      vm.filterAction = 'publish'
      await flushPromises()
      expect(calls.at(-1)).toEqual({ action: 'publish' })

      vm.filterActor = 'alice'
      await flushPromises()
      expect(calls.at(-1)).toEqual({ action: 'publish', actor: 'alice' })
    })

    it('clears filters via the clear button', async () => {
      const { api, calls } = fakeAuditApi({ events: [], externalSinks: [] })
      const w = mountDrawer(api)
      await flushPromises()
      const vm = w.vm as unknown as {
        filterAction: 'save' | 'publish' | null
        filterActor: string
      }
      vm.filterAction = 'save'
      vm.filterActor = 'bob'
      await flushPromises()
      const callsBefore = calls.length

      const clear = q('audit-clear-filters')
      expect(clear).not.toBeNull()
      ;(clear as HTMLElement).click()
      await flushPromises()
      // A subsequent fetch ran with empty filter.
      expect(calls.length).toBeGreaterThan(callsBefore)
      expect(calls.at(-1)).toEqual({})
    })
  })

  describe('error state', () => {
    it('surfaces fetch errors', async () => {
      const api: AuditApi = {
        async queryAudit() {
          throw new Error('network down')
        },
      }
      mountDrawer(api)
      await flushPromises()
      const err = q('audit-error')
      expect(err).not.toBeNull()
      expect(err!.textContent).toContain('network down')
    })
  })

  describe('event metadata rendering', () => {
    it('displays metadata key/value pairs alongside the event', async () => {
      const { api } = fakeAuditApi({
        events: [
          makeEvent({
            metadata: { targetName: 'production', restoredFrom: 'rev-001' },
          }),
        ],
        externalSinks: [],
      })
      mountDrawer(api)
      await flushPromises()
      const eventEl = qa('.event')[0]
      const text = eventEl.textContent ?? ''
      expect(text).toContain('targetName')
      expect(text).toContain('production')
      expect(text).toContain('restoredFrom')
      expect(text).toContain('rev-001')
    })
  })

  describe('outcome badges', () => {
    it('uses distinct CSS classes per outcome', async () => {
      const { api } = fakeAuditApi({
        events: [
          makeEvent({ outcome: 'success', scope: { kind: 'page', name: 'a' } }),
          makeEvent({ outcome: 'validation-failed', scope: { kind: 'page', name: 'b' } }),
          makeEvent({ outcome: 'forbidden', scope: { kind: 'page', name: 'c' } }),
        ],
        externalSinks: [],
      })
      mountDrawer(api)
      await flushPromises()
      const badges = qa('.outcome')
      expect(badges).toHaveLength(3)
      expect(badges[0].classList.contains('outcome-success')).toBe(true)
      expect(badges[1].classList.contains('outcome-warn')).toBe(true)
      expect(badges[2].classList.contains('outcome-error')).toBe(true)
    })
  })
})
