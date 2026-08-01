/**
 * Storage quota monitoring per `design-offline.md` Q4 "Storage
 * approaching limit":
 *
 *   "When local storage approaches the cap (80% of allocated), a
 *   subtle banner surfaces: 'Storage almost full — please connect
 *   to send your saved items.' Plain language; actionable; appears
 *   once until acknowledged or storage frees."
 *
 * LRU eviction kicks in only at 100% (per `design-cache.md` Gap 1
 * lock). The 80% warning gives the author buffer to act.
 *
 * # Approach
 *
 * Poll `navigator.storage.estimate()` periodically. The estimate
 * reports total origin storage (IndexedDB + Cache API + service
 * worker registrations + localStorage) vs. the browser's per-
 * origin cap. We don't poll aggressively — the cap doesn't change
 * fast, and user actions that consume storage (saves, autosaves)
 * are already low-frequency.
 *
 * # Dismiss-once UX
 *
 * Per the design: "appears once until acknowledged or storage
 * frees." If the user dismisses at 80%, we stash the dismissal
 * threshold; the banner re-appears only when usage crosses BACK
 * UP through that threshold (e.g., user dismisses at 85%, frees
 * to 70%, climbs back to 85% later → banner re-appears).
 *
 * Dismissal is per-tab-session — not persisted across reloads.
 * If the author closes the tab and reopens at the same quota,
 * they see the warning again. Honest: the situation hasn't changed.
 *
 * # SOLID lenses
 *
 *   - SRP: this composable owns "is local storage approaching the
 *     cap?". It does NOT know what to do about it (the banner
 *     component renders the visible state) or how the cache
 *     evicts (cache layer handles 100% via LRU).
 *   - DIP: tests inject a fake `estimateFn` so they can drive the
 *     scenario synchronously without a real navigator.
 */
import { computed, onUnmounted, ref, type Ref } from 'vue'

const POLL_INTERVAL_MS = 60_000
const WARN_THRESHOLD = 0.8

/**
 * Optional injection seam for tests. Production wires through the
 * real `navigator.storage.estimate()`.
 */
type StorageEstimateFn = () => Promise<{ usage?: number; quota?: number }>

export interface StorageQuotaOptions {
  /** Override the polling interval. Tests pass 0 to disable the timer. */
  pollIntervalMs?: number
  /** Override the estimate function for tests. */
  estimateFn?: StorageEstimateFn
}

export interface StorageQuotaState {
  /** Latest sampled usage ratio (0..1) or null if unknown. */
  usageRatio: Ref<number | null>
  /** True when ratio > 0.8 AND user hasn't dismissed at the
   *  current threshold band. The banner consumer reads this. */
  showWarning: Ref<boolean>
  /** Force an immediate sample. Tests use this to drive transitions. */
  sample(): Promise<void>
  /** User dismissed the warning. Re-appears only when usage climbs
   *  back through the dismissal threshold. */
  dismiss(): void
  /** Stop polling + clean up the timer. Auto-called on
   *  onUnmounted when the composable is consumed in a component. */
  stop(): void
}

/**
 * Wire storage-quota monitoring. Call once at admin boot OR from
 * a component (the composable cleans up on unmount).
 *
 * Returns reactive refs the consumer reads. Production callers
 * mount once in a long-lived component (e.g., the offline banner's
 * sibling); tests instantiate per-case with a fake estimateFn.
 */
export function useStorageQuota(opts: StorageQuotaOptions = {}): StorageQuotaState {
  const pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS
  const estimateFn = opts.estimateFn ?? defaultEstimate

  const usageRatio = ref<number | null>(null)
  const dismissedAtRatio = ref<number | null>(null)

  const showWarning = computed<boolean>(() => {
    const r = usageRatio.value
    if (r === null) return false
    if (r < WARN_THRESHOLD) return false
    // If dismissed at a ratio, suppress until usage climbs ABOVE
    // that point. `<=` not `<`: dismissing at 0.85 should suppress
    // at 0.85; only re-fires once we hit 0.86+.
    if (dismissedAtRatio.value !== null && r <= dismissedAtRatio.value) return false
    return true
  })

  async function sample(): Promise<void> {
    try {
      const est = await estimateFn()
      const usage = est.usage ?? 0
      const quota = est.quota ?? 0
      if (quota === 0) {
        usageRatio.value = null
        return
      }
      usageRatio.value = usage / quota
      // If usage drops back below the dismiss threshold, clear it
      // so a future climb re-fires the warning.
      if (dismissedAtRatio.value !== null && usageRatio.value < WARN_THRESHOLD) {
        dismissedAtRatio.value = null
      }
    } catch {
      // navigator.storage.estimate() rejection is rare but possible
      // (older browsers, sandboxed contexts). Treat as "quota
      // unknown" — don't surface a banner; don't crash the app.
      usageRatio.value = null
    }
  }

  function dismiss(): void {
    dismissedAtRatio.value = usageRatio.value
  }

  let timer: ReturnType<typeof setInterval> | null = null
  function stop(): void {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  if (pollIntervalMs > 0) {
    // Kick off an immediate sample; subsequent samples on interval.
    void sample()
    timer = setInterval(() => void sample(), pollIntervalMs)
  }

  // Auto-cleanup when consumed in a component setup.
  onUnmounted(() => stop())

  return { usageRatio, showWarning, sample, dismiss, stop }
}

/** Production estimate — reads `navigator.storage.estimate()` if
 *  the API is available; returns empty estimate otherwise. */
async function defaultEstimate(): Promise<{ usage?: number; quota?: number }> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
    return {}
  }
  return navigator.storage.estimate()
}
