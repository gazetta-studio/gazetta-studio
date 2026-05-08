/**
 * Tests for the templateImpact store + TemplateChangedBanner (Validation Cut 6).
 *
 * Covers the banner-side concerns:
 *   - Store reflects the latest template-changed event
 *   - Single-slot — newer event overwrites older
 *   - Auto-clear timer (60s) fires
 *   - Manual dismiss clears the banner
 *   - Banner only renders when the store has a current event
 *   - Click-through navigates to /dev/editor/{name}?tab=impact
 *
 * Direct event injection via `_applyEventForTest` avoids EventSource
 * setup; the SSE wiring is exercised separately at the e2e layer when
 * we have a dev server running.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import PrimeVue from 'primevue/config'
import TemplateChangedBanner from '../src/client/components/TemplateChangedBanner.vue'
import { useTemplateImpactStore } from '../src/client/stores/templateImpact.js'

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/dev/editor/:name', component: { template: '<div />' }, name: 'dev-editor' },
    ],
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useTemplateImpactStore', () => {
  it('starts with no banner', () => {
    const store = useTemplateImpactStore()
    expect(store.hasBanner).toBe(false)
    expect(store.current).toBeNull()
  })

  it('records the latest template-changed event', () => {
    const store = useTemplateImpactStore()
    store._applyEventForTest({ name: 'hero', affectedItemCount: 2 })
    expect(store.hasBanner).toBe(true)
    expect(store.current?.name).toBe('hero')
    expect(store.current?.affectedItemCount).toBe(2)
  })

  it('newer event overwrites older (single-slot)', () => {
    const store = useTemplateImpactStore()
    store._applyEventForTest({ name: 'hero', affectedItemCount: 2 })
    store._applyEventForTest({ name: 'footer', affectedItemCount: 0 })
    expect(store.current?.name).toBe('footer')
    expect(store.current?.affectedItemCount).toBe(0)
  })

  it('dismisses on manual dismiss()', () => {
    const store = useTemplateImpactStore()
    store._applyEventForTest({ name: 'hero', affectedItemCount: 1 })
    expect(store.hasBanner).toBe(true)
    store.dismiss()
    expect(store.hasBanner).toBe(false)
  })

  it('auto-clears after 60s', () => {
    const store = useTemplateImpactStore()
    store._applyEventForTest({ name: 'hero' })
    expect(store.hasBanner).toBe(true)
    vi.advanceTimersByTime(59_000)
    expect(store.hasBanner).toBe(true)
    vi.advanceTimersByTime(2_000) // total 61s
    expect(store.hasBanner).toBe(false)
  })

  it('resets the auto-clear timer on each new event', () => {
    const store = useTemplateImpactStore()
    store._applyEventForTest({ name: 'hero' })
    vi.advanceTimersByTime(50_000)
    store._applyEventForTest({ name: 'footer' })
    // 50s into hero's clock + 30s post-footer = 80s total, but
    // footer's clock started fresh at 0s so it's only 30s in.
    vi.advanceTimersByTime(30_000)
    expect(store.hasBanner).toBe(true)
    expect(store.current?.name).toBe('footer')
    vi.advanceTimersByTime(31_000)
    expect(store.hasBanner).toBe(false)
  })
})

describe('TemplateChangedBanner', () => {
  it('renders nothing when the store has no event', () => {
    const router = makeRouter()
    const wrapper = mount(TemplateChangedBanner, {
      global: { plugins: [PrimeVue, router] },
    })
    expect(wrapper.find('[data-testid="template-changed-banner"]').exists()).toBe(false)
  })

  it('renders the banner with the template name and affected count', async () => {
    const store = useTemplateImpactStore()
    store._applyEventForTest({ name: 'hero', affectedItemCount: 3 })
    const router = makeRouter()
    const wrapper = mount(TemplateChangedBanner, {
      global: { plugins: [PrimeVue, router] },
    })
    await wrapper.vm.$nextTick()
    const banner = wrapper.find('[data-testid="template-changed-banner"]')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('hero')
    expect(banner.text()).toContain('3 items affected')
  })

  it('singular wording when affectedItemCount is 1', async () => {
    const store = useTemplateImpactStore()
    store._applyEventForTest({ name: 'hero', affectedItemCount: 1 })
    const router = makeRouter()
    const wrapper = mount(TemplateChangedBanner, {
      global: { plugins: [PrimeVue, router] },
    })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="template-changed-banner"]').text()).toContain('1 item affected')
  })

  it('reassuring wording when affectedItemCount is 0', async () => {
    const store = useTemplateImpactStore()
    store._applyEventForTest({ name: 'hero', affectedItemCount: 0 })
    const router = makeRouter()
    const wrapper = mount(TemplateChangedBanner, {
      global: { plugins: [PrimeVue, router] },
    })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="template-changed-banner"]').text()).toContain('no items affected')
  })

  it('omits the count when affectedItemCount is undefined', async () => {
    const store = useTemplateImpactStore()
    store._applyEventForTest({ name: 'hero' }) // no count
    const router = makeRouter()
    const wrapper = mount(TemplateChangedBanner, {
      global: { plugins: [PrimeVue, router] },
    })
    await wrapper.vm.$nextTick()
    const text = wrapper.find('[data-testid="template-changed-banner"]').text()
    expect(text).toContain('hero')
    expect(text).not.toContain('items affected')
  })

  it('clicking "View impact" navigates to /dev/editor/{name}?tab=impact', async () => {
    vi.useRealTimers() // router needs real timers to settle navigation
    const store = useTemplateImpactStore()
    store._applyEventForTest({ name: 'hero', affectedItemCount: 2 })
    const router = makeRouter()
    await router.push('/')
    const wrapper = mount(TemplateChangedBanner, {
      global: { plugins: [PrimeVue, router] },
    })
    await wrapper.vm.$nextTick()
    await wrapper.find('[data-testid="template-changed-banner-view"]').trigger('click')
    await router.isReady()
    await wrapper.vm.$nextTick()
    await new Promise(r => setTimeout(r, 0))
    expect(router.currentRoute.value.path).toBe('/dev/editor/hero')
    expect(router.currentRoute.value.query.tab).toBe('impact')
    // Banner dismisses after navigation
    expect(store.hasBanner).toBe(false)
  })

  it('clicking dismiss clears the banner without navigating', async () => {
    const store = useTemplateImpactStore()
    store._applyEventForTest({ name: 'hero', affectedItemCount: 2 })
    const router = makeRouter()
    await router.push('/')
    const wrapper = mount(TemplateChangedBanner, {
      global: { plugins: [PrimeVue, router] },
    })
    await wrapper.vm.$nextTick()
    await wrapper.find('[data-testid="template-changed-banner-dismiss"]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(store.hasBanner).toBe(false)
    expect(router.currentRoute.value.path).toBe('/')
  })
})
