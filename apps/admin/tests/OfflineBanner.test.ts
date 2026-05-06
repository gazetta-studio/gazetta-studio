/**
 * Component tests for OfflineBanner.vue per `design-offline.md`
 * Q4 sync-state visibility.
 *
 *   - Hidden when state is `online` (absence is the state)
 *   - Renders persistent banner when state is `offline`
 *   - Renders subtle indicator when state is `degraded`
 *   - Renders subtle indicator when state is `reconnecting`
 *   - "Send now" button triggers connection probe
 *   - "Connection back" toast fires on offline → online transition
 *   - Plain language locked: no jargon ("STALE", "Disconnected", etc.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import PrimeVue from 'primevue/config'
import OfflineBanner from '../src/client/components/OfflineBanner.vue'
import { configureConnectionState, useConnectionState } from '../src/client/stores/connectionState.js'
import { useToastStore } from '../src/client/stores/toast.js'

afterEach(() => vi.restoreAllMocks())

function mountBanner() {
  return mount(OfflineBanner, {
    global: { plugins: [PrimeVue] },
  })
}

describe('OfflineBanner — visibility per state', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    configureConnectionState({ manualMode: true, heartbeatFn: async () => true })
  })

  it('renders nothing when online (absence is the state)', () => {
    useConnectionState() // online by default
    const wrapper = mountBanner()
    expect(wrapper.find('[data-testid="offline-banner"]').exists()).toBe(false)
  })

  it('renders persistent banner with "Offline" + "Send now" when state is offline', async () => {
    const connection = useConnectionState()
    // Drive to offline via 3 consecutive failed heartbeats.
    configureConnectionState({ manualMode: true, heartbeatFn: async () => false })
    setActivePinia(createPinia())
    const c2 = useConnectionState()
    await c2.tick()
    await c2.tick()
    await c2.tick()
    expect(c2.status).toBe('offline')

    const wrapper = mountBanner()
    const banner = wrapper.find('[data-testid="offline-banner"]')
    expect(banner.exists()).toBe(true)
    expect(banner.attributes('data-state')).toBe('offline')
    expect(wrapper.text()).toContain('Offline')
    expect(wrapper.find('[data-testid="offline-banner-send-now"]').exists()).toBe(true)
    // Suppress unused-var lint
    void connection
  })

  it('renders subtle "Connection unstable" when state is degraded', async () => {
    const connection = useConnectionState()
    connection.reportFailure()
    expect(connection.status).toBe('degraded')

    const wrapper = mountBanner()
    const banner = wrapper.find('[data-testid="offline-banner"]')
    expect(banner.exists()).toBe(true)
    expect(banner.attributes('data-state')).toBe('degraded')
    expect(wrapper.text()).toContain('Connection unstable')
    // No Send now button on degraded — author isn't blocked yet.
    expect(wrapper.find('[data-testid="offline-banner-send-now"]').exists()).toBe(false)
  })

  it('"Send now" button calls connectionState.probeNow', async () => {
    setActivePinia(createPinia())
    configureConnectionState({ manualMode: true, heartbeatFn: async () => false })
    const connection = useConnectionState()
    await connection.tick()
    await connection.tick()
    await connection.tick()
    expect(connection.status).toBe('offline')

    const probeSpy = vi.spyOn(connection, 'probeNow').mockResolvedValue()

    const wrapper = mountBanner()
    await wrapper.find('[data-testid="offline-banner-send-now"]').trigger('click')

    expect(probeSpy).toHaveBeenCalledOnce()
  })
})

describe('OfflineBanner — reconnect toast', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // Heartbeat doesn't matter for these tests — we drive `status`
    // directly via $patch since the watcher just observes the ref.
    configureConnectionState({ manualMode: true, heartbeatFn: async () => false })
  })

  it('fires "Connection back" toast on offline → online transition', async () => {
    const connection = useConnectionState()
    // Seed offline state. Drive 3 failed ticks; manualMode means
    // no scheduler runs.
    await connection.tick()
    await connection.tick()
    await connection.tick()
    expect(connection.status).toBe('offline')

    // Mount AFTER offline so `wasOffline = true` captures correctly
    // in the component's onMounted hook.
    const wrapper = mountBanner()
    const toast = useToastStore()
    const showSpy = vi.spyOn(toast, 'show')

    // Patch status to online — this is the transition the watcher fires on.
    connection.$patch({ status: 'online' })
    await wrapper.vm.$nextTick()

    expect(showSpy).toHaveBeenCalled()
    const [message, opts] = showSpy.mock.calls[0]
    expect(message).toBe('Connection back')
    expect(opts?.type).toBe('info')
  })

  it('does NOT fire toast on online → degraded (no spurious "back" message)', async () => {
    const connection = useConnectionState()
    expect(connection.status).toBe('online')

    const wrapper = mountBanner()
    const toast = useToastStore()
    const showSpy = vi.spyOn(toast, 'show')

    connection.reportFailure() // online → degraded
    await wrapper.vm.$nextTick()
    expect(showSpy).not.toHaveBeenCalled()
  })
})

describe('OfflineBanner — plain language lock', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    configureConnectionState({ manualMode: true, heartbeatFn: async () => false })
  })

  it('does NOT render wire-layer jargon (STALE, Disconnected, etag, etc.)', async () => {
    const connection = useConnectionState()
    await connection.tick()
    await connection.tick()
    await connection.tick()
    const wrapper = mountBanner()

    const text = wrapper.text().toLowerCase()
    expect(text).not.toContain('stale')
    expect(text).not.toContain('disconnect')
    expect(text).not.toContain('etag')
    expect(text).not.toContain('queue')
    expect(text).not.toContain('retry')
    expect(text).not.toContain('sync') // "Send now", not "Sync now"
  })
})
