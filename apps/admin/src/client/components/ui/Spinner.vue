<script setup lang="ts">
/**
 * Spinner (design-admin-ui.md, "The components"): the one 1.5rem loading
 * indicator the admin uses, replacing PrimeVue ProgressSpinner. It's a status,
 * so it carries a label (default "Loading"); override with `aria-label`.
 * `strokeWidth` is in ProgressSpinner's units (a 100-unit circle of radius 20),
 * so call sites keep their value.
 */
withDefaults(defineProps<{ strokeWidth?: number | string }>(), { strokeWidth: 2 })
</script>

<template>
  <span class="ui-spinner" role="status" aria-label="Loading">
    <svg viewBox="25 25 50 50" aria-hidden="true">
      <circle class="ui-spinner-track" cx="50" cy="50" r="20" :stroke-width="strokeWidth" />
      <circle class="ui-spinner-arc" cx="50" cy="50" r="20" :stroke-width="strokeWidth" />
    </svg>
  </span>
</template>

<style scoped>
.ui-spinner {
  display: inline-block;
  inline-size: 1.5rem;
  block-size: 1.5rem;
}
.ui-spinner svg {
  inline-size: 100%;
  block-size: 100%;
  animation: ui-spinner-rotate 0.9s linear infinite;
}
.ui-spinner circle {
  fill: none;
}
.ui-spinner-track {
  stroke: var(--color-border);
}
.ui-spinner-arc {
  stroke: var(--color-primary);
  stroke-linecap: round;
  stroke-dasharray: 126;
  stroke-dashoffset: 88;
}
@keyframes ui-spinner-rotate {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .ui-spinner svg {
    animation-duration: 2.7s;
  }
}
</style>
