<script setup lang="ts">
/**
 * Storage-quota warning banner per `design-offline.md` Q4
 * "Storage approaching limit." Shows a subtle banner when local
 * storage usage exceeds 80% of the browser's per-origin cap.
 *
 * Plain language locked: "Storage almost full" — not "Quota
 * exceeded" or "IndexedDB at 80%." Author-facing copy stays Krug-
 * clean.
 *
 * # Dismiss-once UX
 *
 * Click the close button → banner hides at the current usage
 * threshold; reappears only when usage climbs back through that
 * level. Per-tab-session dismissal — closing + reopening the tab
 * resurrects the warning if quota is still high.
 *
 * # Mounted in App.vue alongside OfflineBanner
 *
 * Two thin top-of-app strips can coexist (offline + storage
 * warning are independent concerns). Order: offline banner first
 * (more urgent), storage banner second.
 *
 * # SOLID lenses
 *
 *   - SRP: this component renders quota visibility. The polling
 *     + threshold logic lives in `useStorageQuota`; the cache
 *     LRU eviction at 100% lives in the cache layer.
 *   - DIP: depends on `useStorageQuota`'s typed API; doesn't know
 *     how the estimate is sampled.
 */
import Button from 'primevue/button'
import { useStorageQuota } from '../composables/useStorageQuota.js'

const quota = useStorageQuota()
</script>

<template>
  <div
    v-if="quota.showWarning.value"
    class="storage-quota-banner"
    role="status"
    data-testid="storage-quota-banner">
    <i class="pi pi-database banner-icon" aria-hidden="true" />
    <span class="banner-text">
      Storage almost full — please connect to send your saved items.
    </span>
    <Button
      icon="pi pi-times"
      text
      rounded
      size="small"
      severity="secondary"
      class="banner-dismiss"
      aria-label="Dismiss storage warning"
      data-testid="storage-quota-banner-dismiss"
      @click="quota.dismiss()" />
  </div>
</template>

<style scoped>
.storage-quota-banner {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.75rem;
  font-size: 0.8125rem;
  background: var(--color-warning-bg);
  color: var(--color-warning-fg);
  border-bottom: 1px solid var(--color-warning-fg);
}
.banner-icon {
  font-size: 0.875rem;
}
.banner-text {
  flex: 1;
}
.banner-dismiss {
  margin-inline-start: auto;
}
</style>
