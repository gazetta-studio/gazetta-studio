<script setup lang="ts">
/**
 * Spinner (design-admin-ui.md, "The components"): the one 1.5rem loading
 * indicator the admin uses, replacing PrimeVue ProgressSpinner. It's a status,
 * so it carries a label (default "Loading"); override with `aria-label`.
 */
</script>

<template>
  <span class="ui-spinner" role="status" aria-label="Loading">
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle class="ui-spinner-track" cx="12" cy="12" r="9.5" />
      <circle class="ui-spinner-arc" cx="12" cy="12" r="9.5" />
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
  stroke-width: 3;
}
.ui-spinner-track {
  stroke: var(--color-border);
}
.ui-spinner-arc {
  stroke: var(--color-primary);
  stroke-linecap: round;
  stroke-dasharray: 60;
  stroke-dashoffset: 42;
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
