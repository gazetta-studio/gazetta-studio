<!--
  StateBadge — presentational primitive for dot and pill state
  indicators. Per `design-review-workflow.md` "UX implementation
  foundation": extracts the dot/pill pattern duplicated across
  SiteTree.vue (dirty dot, validation dot, locale pill) and
  ComponentTree.vue.

  Additive — shipped components keep their inline markup. A Boy-Scout
  refactor can migrate them later; it isn't required by this cut.

  Pure presentational: no store reads, no logic. SRP — one job: paint a
  colored dot or a pill with a label. Colors driven by tokens per
  css-theming.md (--color-warning-fg / --color-danger-fg /
  --color-success-fg / --color-info-fg / --color-muted) so the component
  auto-flips light/dark through the token layer.

  Accessibility:
    - dot + label → `role="img"` + `aria-label` (axe's
      aria-prohibited-attr forbids aria-label on a bare span; `img`
      is the right role for a graphical state indicator with an
      accessible name — avoids `status`, which is a live region)
    - dot without label or tooltip → `aria-hidden="true"` (decorative;
      the surrounding row IS the semantic context)
    - tooltip → `title` attribute (hover-only, not an AT substitute)
    - pill → the label text IS the accessible name
-->
<script setup lang="ts">
type Variant = 'dot' | 'pill'
type Color = 'warning' | 'danger' | 'success' | 'info' | 'muted'

defineProps<{
  variant: Variant
  color: Color
  label?: string
  tooltip?: string
}>()
</script>

<template>
  <span
    v-if="variant === 'dot'"
    :class="['state-badge', 'state-badge-dot', `state-badge-${color}`]"
    :title="tooltip"
    :role="label ? 'img' : undefined"
    :aria-label="label"
    :aria-hidden="label || tooltip ? undefined : 'true'"
  />
  <span
    v-else
    :class="['state-badge', 'state-badge-pill', `state-badge-${color}`]"
    :title="tooltip"
  >
    {{ label }}
  </span>
</template>

<style scoped>
.state-badge {
  display: inline-block;
  flex-shrink: 0;
  vertical-align: middle;
}

.state-badge-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.state-badge-pill {
  font-size: 0.625rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  border: 1px solid currentColor;
  border-radius: 2px;
  padding: 0 4px;
  line-height: 1.4;
  background: transparent;
}

.state-badge-dot.state-badge-warning { background: var(--color-warning-fg); }
.state-badge-dot.state-badge-danger  { background: var(--color-danger-fg); }
.state-badge-dot.state-badge-success { background: var(--color-success-fg); }
.state-badge-dot.state-badge-info    { background: var(--color-info-fg); }
.state-badge-dot.state-badge-muted   { background: var(--color-muted); }

.state-badge-pill.state-badge-warning { color: var(--color-warning-fg); }
.state-badge-pill.state-badge-danger  { color: var(--color-danger-fg); }
.state-badge-pill.state-badge-success { color: var(--color-success-fg); }
.state-badge-pill.state-badge-info    { color: var(--color-info-fg); }
.state-badge-pill.state-badge-muted   { color: var(--color-muted); }
</style>
