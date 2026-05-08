/**
 * Template impact store (Validation Cut 6).
 *
 * Subscribes to the `/__validation` SSE channel for `template-changed`
 * events; when one arrives the store stashes the most recent
 * `{ name, affectedItemCount, at }` so the toolbar
 * `TemplateChangedBanner` can surface "Template `hero` changed —
 * N items affected" until the dev acknowledges or the auto-clear
 * timer fires.
 *
 * Auto-clear:
 *   - 60s timer — fallback in case the dev was AFK or affectedItemCount
 *     was 0 (no follow-up signal expected).
 *   - Scanner reports the affected items clean — when a follow-up
 *     `validation-issues-updated` event arrives and the issuesByItem
 *     map shows zero issues for the items that used the changed
 *     template, the banner clears (the dev fixed the breakage).
 *
 * Single-slot: a newer `template-changed` overwrites the older entry
 * (per design-validation.md "DevPlayground Impact tab + transient
 * banner" — older changes' impact remains in the site-health drawer).
 *
 * # SOLID lenses
 *
 *   - SRP: this store owns the banner's transient state. Site-wide
 *     issues live in `useValidationScannerStore`; per-template impact
 *     fetched on-demand by the playground via the API client.
 *   - DIP: SSE wiring sits behind the store; consumers only see the
 *     reactive `current` ref + `dismiss()` action.
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useValidationScannerStore } from './validationScanner.js'

const AUTO_CLEAR_MS = 60_000

export interface TemplateChangedEvent {
  /** Template that changed (e.g., 'hero'). */
  name: string
  /**
   * Items using the template that have any issue post-rescan. May be
   * undefined when the scanner couldn't compute the count (best-effort
   * per scanner's emit). Banner falls back to "changed" without a
   * number when undefined.
   */
  affectedItemCount?: number
  /** Wall-clock timestamp when the event arrived. Drives the auto-clear timer. */
  at: number
  /** Wall-clock duration of the rescan in ms (informational). */
  durationMs?: number
}

export const useTemplateImpactStore = defineStore('templateImpact', () => {
  const current = ref<TemplateChangedEvent | null>(null)
  let autoClearTimer: ReturnType<typeof setTimeout> | null = null

  /** Has an active banner to show? */
  const hasBanner = computed(() => current.value !== null)

  function dismiss(): void {
    current.value = null
    if (autoClearTimer) {
      clearTimeout(autoClearTimer)
      autoClearTimer = null
    }
  }

  /**
   * Internal — applies an incoming SSE event. Schedules the 60s
   * auto-clear and replaces any prior in-flight banner.
   */
  function applyEvent(event: { name: string; affectedItemCount?: number; durationMs?: number }): void {
    if (autoClearTimer) clearTimeout(autoClearTimer)
    current.value = {
      name: event.name,
      affectedItemCount: event.affectedItemCount,
      durationMs: event.durationMs,
      at: Date.now(),
    }
    autoClearTimer = setTimeout(() => {
      current.value = null
      autoClearTimer = null
    }, AUTO_CLEAR_MS)
  }

  let eventSource: EventSource | null = null

  /**
   * Open the SSE stream. Idempotent. Reuses the validation scanner
   * store's existing `/__validation` channel — same endpoint, two
   * event types: `validation-issues-updated` (Cut 2; site-health
   * drawer) and `template-changed` (Cut 6; this store).
   */
  function subscribe(): void {
    // Make sure the scanner store is also subscribed so the second
    // signal (issues cleared on the affected items) is observable.
    useValidationScannerStore().subscribe()
    if (eventSource) return
    try {
      eventSource = new EventSource('/__validation', { withCredentials: false })
      eventSource.addEventListener('template-changed', (ev: MessageEvent) => {
        try {
          const data = JSON.parse(ev.data) as { name: string; affectedItemCount?: number; durationMs?: number }
          if (data && typeof data.name === 'string') applyEvent(data)
        } catch {
          // Malformed payload — ignore; banner just doesn't surface.
        }
      })
      eventSource.onerror = () => {
        // EventSource auto-reconnects; nothing to do here.
      }
    } catch {
      eventSource = null
    }
  }

  function unsubscribe(): void {
    if (eventSource) {
      eventSource.close()
      eventSource = null
    }
    if (autoClearTimer) {
      clearTimeout(autoClearTimer)
      autoClearTimer = null
    }
  }

  return {
    current,
    hasBanner,
    dismiss,
    subscribe,
    unsubscribe,
    // Exposed for tests — direct push without an EventSource.
    _applyEventForTest: applyEvent,
  }
})
