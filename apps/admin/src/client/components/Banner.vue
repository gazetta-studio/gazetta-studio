<!--
  Banner — presentational frame for an inline notice: severity-tinted
  box with an icon, message content, optional actions, optional dismiss.
  Per `design-review-workflow.md` "UX implementation foundation".

  Additive: the shipped banners keep their own markup.

  The banner never hides itself on dismiss — it emits `dismiss` and the
  consumer owns visibility, so a consumer can persist "dismissed" state
  however it needs to.

  Role defaults: danger/warning interrupt (`alert`, assertive live
  region); info/success don't (`status`, polite). A consumer that
  renders a banner on page load rather than in response to an event
  can pass `role="status"` to avoid an assertive announcement.
-->
<script setup lang="ts">
import { CircleCheck, CircleX, Info, TriangleAlert, X } from '@lucide/vue'
import { type Component, computed } from 'vue'
import Button from './ui/Button.vue'

type Severity = 'danger' | 'warning' | 'info' | 'success'

const DEFAULT_ICON: Record<Severity, Component> = {
  danger: CircleX,
  warning: TriangleAlert,
  info: Info,
  success: CircleCheck,
}

const props = defineProps<{
  severity: Severity
  role?: 'alert' | 'status'
  icon?: Component
  dismissible?: boolean
}>()

const emit = defineEmits<{ dismiss: [] }>()

const resolvedRole = computed(
  () => props.role ?? (props.severity === 'danger' || props.severity === 'warning' ? 'alert' : 'status'),
)
const resolvedIcon = computed(() => props.icon ?? DEFAULT_ICON[props.severity])
</script>

<template>
  <div :class="['banner', `banner-${severity}`]" :role="resolvedRole" :data-severity="severity">
    <div class="banner-message">
      <component :is="resolvedIcon" class="banner-icon" aria-hidden="true" />
      <div class="banner-text"><slot /></div>
    </div>
    <div v-if="$slots.actions" class="banner-actions">
      <slot name="actions" />
    </div>
    <Button
      v-if="dismissible"
      :icon="X"
      size="small"
      text
      rounded
      severity="secondary"
      aria-label="Dismiss"
      class="banner-dismiss"
      data-testid="banner-dismiss"
      @click="emit('dismiss')"
    />
  </div>
</template>

<style scoped>
.banner {
  display: flex;
  align-items: center;
  gap: 1rem;
  border: 1px solid;
  border-radius: var(--radius-sm);
  padding: 0.625rem 0.875rem;
  margin: 0.5rem 0;
}
.banner-message {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  flex: 1;
  min-width: 0;
}
.banner-icon {
  inline-size: 1.125rem;
  block-size: 1.125rem;
  flex-shrink: 0;
}
.banner-text {
  font-size: 0.875rem;
  color: var(--color-fg);
}
.banner-actions {
  display: flex;
  gap: 0.375rem;
  flex-shrink: 0;
}
.banner-dismiss {
  flex-shrink: 0;
}

.banner-danger  { background: var(--color-danger-bg);  border-color: var(--color-danger-fg); }
.banner-warning { background: var(--color-warning-bg); border-color: var(--color-warning-fg); }
.banner-info    { background: var(--color-info-bg);    border-color: var(--color-info-fg); }
.banner-success { background: var(--color-success-bg); border-color: var(--color-success-fg); }

.banner-danger  .banner-icon { color: var(--color-danger-fg); }
.banner-warning .banner-icon { color: var(--color-warning-fg); }
.banner-info    .banner-icon { color: var(--color-info-fg); }
.banner-success .banner-icon { color: var(--color-success-fg); }
</style>
