<script setup lang="ts">
/**
 * One radio button of a RadioGroup, on Reka's RadioGroupItem (a <button
 * role="radio">). PrimeVue's RadioButton props: `inputId` becomes the button's
 * id, so an external `<label for>` (or a wrapping <label>) selects and names it.
 */
import { RadioGroupIndicator, RadioGroupItem } from 'reka-ui'

defineProps<{
  // `any`: matches RadioGroup's modelValue.
  value: any
  inputId?: string
  disabled?: boolean
}>()
</script>

<template>
  <RadioGroupItem :id="inputId" class="ui-radio" :value="value" :disabled="disabled">
    <RadioGroupIndicator class="ui-radio-dot" />
  </RadioGroupItem>
</template>

<style scoped>
.ui-radio {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  inline-size: 1.125rem;
  block-size: 1.125rem;
  padding: 0;
  border: 1px solid var(--color-muted);
  border-radius: var(--radius-full);
  background: var(--color-input-bg);
  cursor: pointer;
}
.ui-radio[data-state='checked'],
.ui-radio:hover:not(:disabled) {
  border-color: var(--color-primary);
}
.ui-radio:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.ui-radio:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.ui-radio-dot {
  inline-size: 0.5rem;
  block-size: 0.5rem;
  border-radius: var(--radius-full);
  background: var(--color-primary);
}
</style>
