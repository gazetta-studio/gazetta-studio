/**
 * Tests for the Cut 11 service-worker update composable.
 *
 * The composable wraps `useRegisterSW` from vite-plugin-pwa's
 * virtual module. We mock the virtual module so the test runs
 * without an actual SW registration; then verify:
 *
 *   - On boot: useRegisterSW is called with onRegisteredSW that
 *     wires the periodic update check
 *   - When `needRefresh` flips to true → toast fires with
 *     "Refresh" action
 *   - Clicking the action invokes updateServiceWorker (sends
 *     SKIP_WAITING + reloads)
 *   - When `needRefresh` is false (initial state) → no toast
 *
 * Module-level vi.mock — the virtual module is replaced before
 * any imports resolve.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref, type Ref } from 'vue'
import { setActivePinia, createPinia } from 'pinia'

// Hoisted stubs — available to vi.mock factory before
// useServiceWorkerUpdate.ts imports the virtual module.
const mocks = vi.hoisted(() => {
  const needRefresh: Ref<boolean> = { value: false } as unknown as Ref<boolean>
  const updateServiceWorker = vi.fn(async () => {})
  return {
    needRefresh,
    updateServiceWorker,
    capturedOptions: {
      value: null as unknown as {
        onRegisteredSW?: (url: string, registration?: ServiceWorkerRegistration) => void
      } | null,
    },
  }
})

vi.mock('virtual:pwa-register/vue', () => ({
  useRegisterSW: vi.fn(opts => {
    mocks.capturedOptions.value = opts ?? null
    return {
      needRefresh: mocks.needRefresh,
      offlineReady: { value: false },
      updateServiceWorker: mocks.updateServiceWorker,
    }
  }),
}))

// Import AFTER vi.mock so the mocked virtual module is resolved.
import { useServiceWorkerUpdate } from '../src/client/composables/useServiceWorkerUpdate.js'
import { useToastStore } from '../src/client/stores/toast.js'

beforeEach(() => {
  setActivePinia(createPinia())
  // Reset the reactive ref + spies between tests. The needRefresh
  // ref is shared across the test file (it's hoisted); resetting
  // its value avoids cross-test bleed.
  mocks.needRefresh.value = false
  mocks.updateServiceWorker.mockClear()
  mocks.capturedOptions.value = null
})

afterEach(() => vi.restoreAllMocks())

describe('useServiceWorkerUpdate', () => {
  it('does NOT show a toast on initial registration (needRefresh starts false)', () => {
    // Use a real reactive ref so Vue's watch picks up changes later.
    mocks.needRefresh = ref(false) as unknown as typeof mocks.needRefresh

    useServiceWorkerUpdate()
    const toast = useToastStore()
    // No toast yet — the registered SW hasn't detected an update.
    expect(toast.current).toBeNull()
  })

  it('passes onRegisteredSW so vite-plugin-pwa can wire periodic update checks', () => {
    mocks.needRefresh = ref(false) as unknown as typeof mocks.needRefresh
    useServiceWorkerUpdate()

    const opts = mocks.capturedOptions.value
    expect(opts).not.toBeNull()
    expect(typeof opts!.onRegisteredSW).toBe('function')
  })

  it('schedules a periodic update.update() when onRegisteredSW receives a registration', () => {
    mocks.needRefresh = ref(false) as unknown as typeof mocks.needRefresh
    useServiceWorkerUpdate()

    const updateSpy = vi.fn().mockResolvedValue(undefined)
    const fakeRegistration = { update: updateSpy } as unknown as ServiceWorkerRegistration

    // Use fake timers to verify the interval schedule without
    // sleeping for an hour.
    vi.useFakeTimers()
    mocks.capturedOptions.value!.onRegisteredSW!('http://x/sw.js', fakeRegistration)

    // No call on registration; the interval fires later.
    expect(updateSpy).not.toHaveBeenCalled()

    // Advance past the 1-hour periodic check.
    vi.advanceTimersByTime(60 * 60 * 1000)
    expect(updateSpy).toHaveBeenCalledTimes(1)

    // Advance another hour — fires again.
    vi.advanceTimersByTime(60 * 60 * 1000)
    expect(updateSpy).toHaveBeenCalledTimes(2)

    vi.useRealTimers()
  })

  it('does NOT schedule an interval when onRegisteredSW is called with undefined registration', () => {
    mocks.needRefresh = ref(false) as unknown as typeof mocks.needRefresh
    useServiceWorkerUpdate()

    vi.useFakeTimers()
    // Some plugin paths invoke onRegisteredSW with no registration
    // (registration failure, browser blocks SW, etc.). The
    // composable must not schedule an interval against undefined.
    mocks.capturedOptions.value!.onRegisteredSW!('http://x/sw.js', undefined)
    vi.advanceTimersByTime(60 * 60 * 1000)
    // No timer scheduled → no errors. Sanity check: advanceTimersByTime
    // doesn't throw, no spy to assert against here. The lack of
    // crash IS the assertion.
    vi.useRealTimers()
  })

  it('shows a "new version available" toast when needRefresh flips to true', async () => {
    // Real reactive ref so Vue's watch fires on .value change.
    mocks.needRefresh = ref(false) as unknown as typeof mocks.needRefresh

    useServiceWorkerUpdate()
    const toast = useToastStore()
    expect(toast.current).toBeNull()

    // Trigger the new-version detection.
    mocks.needRefresh.value = true
    // watch() fires on the next microtask tick.
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(toast.current).not.toBeNull()
    expect(toast.current!.message).toContain('new version')
    expect(toast.current!.type).toBe('info')
    expect(toast.current!.action).toBeDefined()
    expect(toast.current!.action!.label).toBe('Refresh')
  })

  it('toast action calls updateServiceWorker(true) on click', async () => {
    mocks.needRefresh = ref(false) as unknown as typeof mocks.needRefresh

    useServiceWorkerUpdate()
    mocks.needRefresh.value = true
    await new Promise(resolve => setTimeout(resolve, 0))

    const toast = useToastStore()
    expect(toast.current?.action).toBeDefined()

    // Trigger the action — should send SKIP_WAITING + reload via
    // the mocked updateServiceWorker.
    await toast.runAction()
    expect(mocks.updateServiceWorker).toHaveBeenCalledOnce()
    expect(mocks.updateServiceWorker).toHaveBeenCalledWith(true)
  })

  it('does NOT re-fire toast when needRefresh stays true across reactive ticks', async () => {
    mocks.needRefresh = ref(false) as unknown as typeof mocks.needRefresh

    useServiceWorkerUpdate()
    const toast = useToastStore()
    const showSpy = vi.spyOn(toast, 'show')

    mocks.needRefresh.value = true
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(showSpy).toHaveBeenCalledTimes(1)

    // Keep needRefresh true — Vue's watch only fires on value
    // CHANGE. Setting the same value shouldn't re-fire.
    mocks.needRefresh.value = true
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(showSpy).toHaveBeenCalledTimes(1)
  })

  it('emits a sticky toast (duration: 0) so author can finish editing before refreshing', async () => {
    mocks.needRefresh = ref(false) as unknown as typeof mocks.needRefresh

    useServiceWorkerUpdate()
    const toast = useToastStore()
    const showSpy = vi.spyOn(toast, 'show')

    mocks.needRefresh.value = true
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(showSpy).toHaveBeenCalledOnce()
    const opts = showSpy.mock.calls[0][1]
    // duration: 0 = no auto-dismiss; toast hangs until user clicks
    // Refresh or another toast replaces it.
    expect(opts?.duration).toBe(0)
  })
})
