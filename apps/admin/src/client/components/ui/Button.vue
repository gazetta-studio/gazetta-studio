<script setup lang="ts">
/**
 * Button (design-admin-ui.md, "The components"): a native <button> with
 * PrimeVue's prop names, so cut 2 swaps imports without touching call sites.
 * `icon` takes a Lucide component.
 * Attributes (data-testid, title, aria-*, class) land on the <button>.
 */
import { LoaderCircle } from '@lucide/vue'
import { type Component, computed, useAttrs, useSlots, watchEffect } from 'vue'
import type { Severity } from './severity'

const props = defineProps<{
  label?: string
  icon?: Component
  severity?: Severity
  text?: boolean
  outlined?: boolean
  rounded?: boolean
  size?: 'small'
  loading?: boolean
  disabled?: boolean
  badge?: string
}>()

const attrs = useAttrs()
const slots = useSlots()

const iconOnly = computed(() => !props.label && !slots.default)

// An icon-only button has no visible text, so it needs an accessible name.
if (import.meta.env.DEV) {
  watchEffect(() => {
    if (iconOnly.value && !attrs['aria-label'] && !attrs['aria-labelledby']) {
      console.warn('[ui/Button] An icon-only Button needs an aria-label.')
    }
  })
}

const variant = computed(() => (props.text ? 'text' : props.outlined ? 'outlined' : 'solid'))
</script>

<template>
  <button
    type="button"
    class="ui-button"
    :class="[
      `ui-button--${severity ?? 'primary'}`,
      `ui-button--${variant}`,
      { 'ui-button--small': size === 'small', 'ui-button--rounded': rounded, 'ui-button--icon-only': iconOnly },
    ]"
    :disabled="disabled || loading"
    :aria-busy="loading || undefined"
  >
    <LoaderCircle v-if="loading" class="ui-button-icon ui-spin" aria-hidden="true" />
    <component :is="icon" v-else-if="icon" class="ui-button-icon" aria-hidden="true" />
    <span v-if="label || $slots.default" class="ui-button-label"><slot>{{ label }}</slot></span>
    <span v-if="badge" class="ui-button-badge" :class="`ui-button-badge--${severity ?? 'primary'}`">{{ badge }}</span>
  </button>
</template>

<style scoped>
.ui-button {
  /* Each severity sets --ui-tone (fill / text colour) and --ui-on-tone (text on a fill). */
  --ui-tone: var(--color-primary);
  --ui-on-tone: var(--color-on-primary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  padding-block: 0.5rem;
  padding-inline: 0.875rem;
  border: 1px solid var(--ui-tone);
  border-radius: var(--radius-md);
  background: var(--ui-tone);
  color: var(--ui-on-tone);
  font: inherit;
  font-size: 0.875rem;
  font-weight: 500;
  line-height: 1.25rem;
  cursor: pointer;
  white-space: nowrap;
  transition: filter 0.15s, background-color 0.15s;
}
.ui-button--secondary {
  --ui-tone: var(--color-fg);
  --ui-on-tone: var(--color-fg);
}
.ui-button--danger {
  --ui-tone: var(--color-danger);
  --ui-on-tone: var(--color-on-danger);
}
.ui-button--success {
  --ui-tone: var(--color-success);
  --ui-on-tone: var(--color-on-success);
}
.ui-button--warn {
  --ui-tone: var(--color-warn);
  --ui-on-tone: var(--color-on-warn);
}
.ui-button--info {
  --ui-tone: var(--color-info);
  --ui-on-tone: var(--color-on-info);
}
/* Secondary is the quiet filled button: chip background, normal text. */
.ui-button--secondary.ui-button--solid {
  background: var(--color-bg-chip);
  border-color: var(--color-border);
}
.ui-button--outlined {
  background: transparent;
  color: var(--ui-tone);
}
.ui-button--text {
  background: transparent;
  border-color: transparent;
  color: var(--ui-tone);
}
.ui-button--secondary.ui-button--outlined,
.ui-button--secondary.ui-button--text {
  color: var(--color-fg);
}
.ui-button:hover:not(:disabled) {
  filter: brightness(0.92);
}
.ui-button--text:hover:not(:disabled),
.ui-button--outlined:hover:not(:disabled) {
  filter: none;
  background: var(--color-hover-bg);
}
.ui-button:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.ui-button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.ui-button--small {
  padding-block: 0.3125rem;
  padding-inline: 0.625rem;
  font-size: 0.8125rem;
}
.ui-button--rounded {
  border-radius: var(--radius-full);
}
.ui-button--icon-only {
  padding-inline: 0.5rem;
}
.ui-button--icon-only.ui-button--small {
  padding-inline: 0.375rem;
}
.ui-button-icon {
  inline-size: 1rem;
  block-size: 1rem;
  flex-shrink: 0;
}
.ui-button-badge {
  --ui-badge-tone: var(--color-primary);
  --ui-badge-on: var(--color-on-primary);
  min-inline-size: 1.25rem;
  padding-inline: 0.375rem;
  border-radius: var(--radius-full);
  background: var(--ui-badge-tone);
  color: var(--ui-badge-on);
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1.25rem;
  text-align: center;
}
.ui-button-badge--secondary {
  --ui-badge-tone: var(--color-bg-chip);
  --ui-badge-on: var(--color-fg);
}
.ui-button-badge--danger {
  --ui-badge-tone: var(--color-danger);
  --ui-badge-on: var(--color-on-danger);
}
.ui-button-badge--success {
  --ui-badge-tone: var(--color-success);
  --ui-badge-on: var(--color-on-success);
}
.ui-button-badge--warn {
  --ui-badge-tone: var(--color-warn);
  --ui-badge-on: var(--color-on-warn);
}
.ui-button-badge--info {
  --ui-badge-tone: var(--color-info);
  --ui-badge-on: var(--color-on-info);
}
</style>
