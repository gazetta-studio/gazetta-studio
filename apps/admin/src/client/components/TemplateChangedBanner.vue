<script setup lang="ts">
/**
 * Template-changed transient banner (Validation Cut 6).
 *
 * Surfaces when the dev server's template watcher fires a hot reload
 * — `templateImpact` store consumes the SSE `template-changed` event
 * and stashes the latest. Click "View impact" routes to the
 * DevPlayground for that template with the Impact tab pre-selected;
 * X dismisses without navigating.
 *
 * Auto-clear: 60s timer in the store.
 *
 * Per `design-validation.md` "DevPlayground Impact tab + transient
 * banner" — this banner is template-developer turf, not daily-author
 * chrome. Mounted at the top of the admin alongside OfflineBanner +
 * StorageQuotaBanner. Compact horizontal strip, Krug-aligned absence-
 * as-state (no banner = nothing to know about).
 *
 * # SOLID lenses
 *
 *   - SRP: this component renders the banner. SSE wiring + auto-clear
 *     timer live in the store.
 *   - DIP: depends on `useTemplateImpactStore`'s typed surface.
 */
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import { useTemplateImpactStore } from '../stores/templateImpact.js'

const store = useTemplateImpactStore()
const router = useRouter()

function viewImpact() {
  const c = store.current
  if (!c) return
  // Land on the DevPlayground with the template selected. The Impact
  // tab gets pre-selected via the `?tab=impact` query param so the
  // dev arrives directly at "what did I break."
  router.push({
    path: `/dev/editor/${encodeURIComponent(c.name)}`,
    query: { tab: 'impact' },
  })
  store.dismiss()
}
</script>

<template>
  <div
    v-if="store.hasBanner && store.current"
    class="template-changed-banner"
    role="status"
    data-testid="template-changed-banner">
    <i class="pi pi-code banner-icon" aria-hidden="true" />
    <span class="banner-text">
      <strong>Template <code>{{ store.current.name }}</code> changed</strong>
      <span v-if="typeof store.current.affectedItemCount === 'number'">
        — {{ store.current.affectedItemCount === 0
          ? 'no items affected'
          : `${store.current.affectedItemCount} ${store.current.affectedItemCount === 1 ? 'item' : 'items'} affected` }}
      </span>
    </span>
    <button
      type="button"
      class="banner-link"
      data-testid="template-changed-banner-view"
      @click="viewImpact">
      View impact →
    </button>
    <Button
      icon="pi pi-times"
      text
      rounded
      size="small"
      severity="secondary"
      class="banner-dismiss"
      aria-label="Dismiss template-changed notice"
      data-testid="template-changed-banner-dismiss"
      @click="store.dismiss()" />
  </div>
</template>

<style scoped>
.template-changed-banner {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.75rem;
  font-size: 0.8125rem;
  background: var(--color-info-bg);
  color: var(--color-info-fg);
  border-bottom: 1px solid var(--color-info-fg);
}
.banner-icon {
  font-size: 0.875rem;
}
.banner-text {
  flex: 1;
}
.banner-text code {
  font-family: ui-monospace, monospace;
  font-size: 0.8125rem;
  padding: 0.0625rem 0.25rem;
  border-radius: var(--p-border-radius-sm);
  background: var(--color-bg);
}
.banner-link {
  background: transparent;
  border: none;
  color: inherit;
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
  padding: 0;
}
.banner-link:hover {
  opacity: 0.85;
}
.banner-dismiss {
  margin-inline-start: 0.25rem;
}
</style>
