/**
 * Tests for the storage-quota composable + banner per
 * `design-offline.md` Q4 "Storage approaching limit."
 *
 * Composable tests use `pollIntervalMs: 0` to disable the timer
 * and drive transitions via `sample()` directly. Banner tests
 * use `mount` with a mock estimate.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import PrimeVue from 'primevue/config'
import { useStorageQuota } from '../src/client/composables/useStorageQuota.js'
import StorageQuotaBanner from '../src/client/components/StorageQuotaBanner.vue'

describe('useStorageQuota', () => {
  function makeEstimate(usage: number, quota: number) {
    return async () => ({ usage, quota })
  }

  it('starts with usageRatio=null + showWarning=false', () => {
    const q = useStorageQuota({ pollIntervalMs: 0, estimateFn: makeEstimate(0, 0) })
    expect(q.usageRatio.value).toBeNull()
    expect(q.showWarning.value).toBe(false)
    q.stop()
  })

  it('reports usage ratio after sampling', async () => {
    const q = useStorageQuota({ pollIntervalMs: 0, estimateFn: makeEstimate(40, 100) })
    await q.sample()
    expect(q.usageRatio.value).toBe(0.4)
    expect(q.showWarning.value).toBe(false)
    q.stop()
  })

  it('does NOT warn below 80% threshold', async () => {
    const q = useStorageQuota({ pollIntervalMs: 0, estimateFn: makeEstimate(79, 100) })
    await q.sample()
    expect(q.showWarning.value).toBe(false)
    q.stop()
  })

  it('warns at or above 80% threshold', async () => {
    const q = useStorageQuota({ pollIntervalMs: 0, estimateFn: makeEstimate(85, 100) })
    await q.sample()
    expect(q.usageRatio.value).toBe(0.85)
    expect(q.showWarning.value).toBe(true)
    q.stop()
  })

  it('dismiss() stops the warning at the current ratio', async () => {
    const q = useStorageQuota({ pollIntervalMs: 0, estimateFn: makeEstimate(85, 100) })
    await q.sample()
    expect(q.showWarning.value).toBe(true)
    q.dismiss()
    expect(q.showWarning.value).toBe(false)
    q.stop()
  })

  it('re-fires the warning when usage climbs back through the dismissal threshold', async () => {
    let usage = 85
    const q = useStorageQuota({ pollIntervalMs: 0, estimateFn: async () => ({ usage, quota: 100 }) })
    await q.sample()
    q.dismiss()
    expect(q.showWarning.value).toBe(false)

    // Usage drops below threshold — dismissal clears.
    usage = 70
    await q.sample()
    expect(q.showWarning.value).toBe(false)

    // Usage climbs strictly above the dismissal point (0.85) — warning reappears.
    usage = 90
    await q.sample()
    expect(q.showWarning.value).toBe(true)
    q.stop()
  })

  it('stays suppressed when usage stays at the dismissal threshold after sampling drift', async () => {
    let usage = 85
    const q = useStorageQuota({ pollIntervalMs: 0, estimateFn: async () => ({ usage, quota: 100 }) })
    await q.sample()
    q.dismiss()
    expect(q.showWarning.value).toBe(false)

    // Same usage on the next poll — banner stays dismissed.
    await q.sample()
    expect(q.showWarning.value).toBe(false)
    q.stop()
  })

  it('handles missing usage / quota fields by reporting null ratio', async () => {
    const q = useStorageQuota({ pollIntervalMs: 0, estimateFn: async () => ({}) })
    await q.sample()
    expect(q.usageRatio.value).toBeNull()
    expect(q.showWarning.value).toBe(false)
    q.stop()
  })

  it('handles estimate rejection gracefully (no crash, no warning)', async () => {
    const q = useStorageQuota({
      pollIntervalMs: 0,
      estimateFn: async () => {
        throw new Error('navigator.storage.estimate rejected')
      },
    })
    await q.sample()
    expect(q.usageRatio.value).toBeNull()
    expect(q.showWarning.value).toBe(false)
    q.stop()
  })

  it('quota=0 reports null (avoids divide-by-zero)', async () => {
    const q = useStorageQuota({ pollIntervalMs: 0, estimateFn: makeEstimate(50, 0) })
    await q.sample()
    expect(q.usageRatio.value).toBeNull()
    q.stop()
  })
})

describe('StorageQuotaBanner', () => {
  /**
   * The banner consumes `useStorageQuota()` internally — that
   * composable reads `navigator.storage.estimate()`. We stub the
   * navigator method globally for these tests so the banner sees a
   * real ratio without polling against a real browser API.
   *
   * jsdom doesn't ship `navigator.storage`, so the stub also
   * defines the shape if missing.
   */
  type StorageEstimateImpl = () => Promise<{ usage?: number; quota?: number }>
  let originalStorage: typeof navigator.storage | undefined
  function stubStorageEstimate(impl: StorageEstimateImpl): void {
    originalStorage = (navigator as { storage?: typeof navigator.storage }).storage
    Object.defineProperty(navigator, 'storage', {
      value: { estimate: impl },
      configurable: true,
    })
  }
  function restoreStorageEstimate(): void {
    if (originalStorage === undefined) {
      // @ts-expect-error: deleting a stubbed property on navigator
      delete (navigator as { storage?: typeof navigator.storage }).storage
    } else {
      Object.defineProperty(navigator, 'storage', {
        value: originalStorage,
        configurable: true,
      })
    }
  }

  afterEach(() => restoreStorageEstimate())

  async function settle(): Promise<void> {
    // Component's onMounted calls `sample()` which awaits
    // navigator.storage.estimate(). Two ticks for safety: one for
    // the awaited estimate, one for Vue's reactivity flush.
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))
  }

  it('renders nothing when storage usage is below threshold', async () => {
    stubStorageEstimate(async () => ({ usage: 40, quota: 100 }))
    const wrapper = mount(StorageQuotaBanner, {
      global: { plugins: [PrimeVue] },
    })
    await settle()
    expect(wrapper.find('[data-testid="storage-quota-banner"]').exists()).toBe(false)
  })

  it('renders banner with plain-language copy when usage exceeds 80%', async () => {
    stubStorageEstimate(async () => ({ usage: 85, quota: 100 }))
    const wrapper = mount(StorageQuotaBanner, {
      global: { plugins: [PrimeVue] },
    })
    await settle()

    const banner = wrapper.find('[data-testid="storage-quota-banner"]')
    expect(banner.exists()).toBe(true)
    // Plain-language copy lock: "almost full" is the user-facing
    // phrasing per design-offline.md Q4.
    expect(banner.text()).toContain('almost full')
    // No jargon.
    const text = banner.text().toLowerCase()
    expect(text).not.toContain('quota')
    expect(text).not.toContain('exceeded')
    expect(text).not.toContain('80')
  })

  it('exposes a dismiss button when banner is shown', async () => {
    stubStorageEstimate(async () => ({ usage: 90, quota: 100 }))
    const wrapper = mount(StorageQuotaBanner, {
      global: { plugins: [PrimeVue] },
    })
    await settle()

    expect(wrapper.find('[data-testid="storage-quota-banner-dismiss"]').exists()).toBe(true)
  })

  it('clicking the dismiss button hides the banner', async () => {
    stubStorageEstimate(async () => ({ usage: 90, quota: 100 }))
    const wrapper = mount(StorageQuotaBanner, {
      global: { plugins: [PrimeVue] },
    })
    await settle()
    expect(wrapper.find('[data-testid="storage-quota-banner"]').exists()).toBe(true)

    await wrapper.find('[data-testid="storage-quota-banner-dismiss"]').trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="storage-quota-banner"]').exists()).toBe(false)
  })
})
