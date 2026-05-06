<script setup lang="ts">
/**
 * Global offline / connection-state banner per `design-offline.md`
 * Q4 (Krug-aligned sync-state visibility).
 *
 * Renders a thin top-of-app strip when the connection state isn't
 * `online`. Per the locked Krug UX:
 *
 *   - `online`        → no banner (absence is the state)
 *   - `degraded`      → subtle "Connection unstable" indicator
 *   - `offline`       → persistent "Offline" banner with "Send now"
 *   - `reconnecting`  → subtle spinner + "Connection back"
 *
 * # Plain language locked
 *
 * "Offline" — not "Disconnected" or "STALE." "Send now" — not
 * "Force sync" or "Retry queue." Author-facing copy stays clean of
 * the wire layer's vocabulary.
 *
 * # Per-item indicators are out of scope here
 *
 * The cloud-with-slash icon on individual saved-locally items
 * requires a per-item save-queue store that doesn't exist yet
 * (Cut 13's mid-save retry will introduce it). Surfacing the icon
 * now would be theater — the indicator would never appear because
 * nothing produces queued state. Cut 13 lights up the per-item
 * indicators automatically when its queue ships.
 *
 * # SOLID lenses
 *
 *   - SRP: this component renders connection-state visibility.
 *     Connection-state itself lives in `useConnectionState`; the
 *     transient "Connection back" toast is fired via the existing
 *     toast store, not state owned here.
 *   - DIP: depends on `useConnectionState`'s typed API; doesn't
 *     know how the heartbeat or navigator events drive transitions.
 *
 * # Why a single component (not three)
 *
 * The four visible states (online, degraded, offline, reconnecting)
 * share one mounting surface and one DOM region. Rendering each
 * via a separate component would fragment the styling concern and
 * push the orchestration into the parent. The `v-if` chain over
 * connectionState.status keeps the surface narrow.
 */
import { onMounted, watch } from 'vue'
import Button from 'primevue/button'
import { useConnectionState } from '../stores/connectionState.js'
import { useToastStore } from '../stores/toast.js'

const connection = useConnectionState()
const toast = useToastStore()

async function sendNow(): Promise<void> {
  // "Send now" affordance per design-offline.md "Force-sync
  // affordance (visible only when relevant)" — fires an immediate
  // probe + replay attempt regardless of the scheduled cadence.
  // Useful when the operator knows the network is back; the
  // connection-state heartbeat may still be backing off.
  await connection.probeNow()
}

// Transient "Connection back" toast on `offline → reconnecting | online`
// transition. Per design-offline.md Q2: "transition to `online`"
// happens immediately after `reconnecting` in v1 (no save queue
// yet). The transition is fast enough that watching for
// `reconnecting` alone misses it; we watch the leading edge of any
// state-change-from-offline.
let wasOffline = false
onMounted(() => {
  wasOffline = connection.status === 'offline'
})
watch(
  () => connection.status,
  next => {
    if (wasOffline && (next === 'online' || next === 'reconnecting')) {
      // Transient — auto-dismiss. Plain language ("Connection back"),
      // no jargon ("Reconnected" technically correct but Krug-ier).
      toast.show('Connection back', { type: 'info', duration: 3000 })
    }
    wasOffline = next === 'offline'
  },
)
</script>

<template>
  <div
    v-if="connection.status === 'offline'"
    class="offline-banner offline-banner-offline"
    role="alert"
    data-testid="offline-banner"
    data-state="offline">
    <i class="pi pi-cloud-slash banner-icon" aria-hidden="true" />
    <span class="banner-text">Offline</span>
    <Button
      size="small"
      severity="secondary"
      outlined
      label="Send now"
      class="banner-action"
      data-testid="offline-banner-send-now"
      @click="sendNow" />
  </div>

  <div
    v-else-if="connection.status === 'degraded'"
    class="offline-banner offline-banner-degraded"
    role="status"
    data-testid="offline-banner"
    data-state="degraded">
    <i class="pi pi-spin pi-spinner banner-icon" aria-hidden="true" />
    <span class="banner-text">Connection unstable</span>
  </div>

  <div
    v-else-if="connection.status === 'reconnecting'"
    class="offline-banner offline-banner-reconnecting"
    role="status"
    data-testid="offline-banner"
    data-state="reconnecting">
    <i class="pi pi-spin pi-spinner banner-icon" aria-hidden="true" />
    <span class="banner-text">Reconnecting</span>
  </div>
</template>

<style scoped>
.offline-banner {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.75rem;
  font-size: 0.8125rem;
  border-bottom: 1px solid transparent;
}
.offline-banner-offline {
  background: var(--color-warning-bg);
  color: var(--color-warning-fg);
  border-bottom-color: var(--color-warning-fg);
  font-weight: 600;
}
.offline-banner-degraded,
.offline-banner-reconnecting {
  background: var(--color-info-bg);
  color: var(--color-info-fg);
  border-bottom-color: var(--color-border);
  font-size: 0.75rem;
  padding-block: 0.25rem;
}
.banner-icon {
  font-size: 0.875rem;
}
.banner-text {
  flex: 1;
}
.banner-action {
  margin-inline-start: auto;
}
</style>
