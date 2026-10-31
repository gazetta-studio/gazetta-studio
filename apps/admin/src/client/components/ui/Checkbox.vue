<script setup lang="ts">
/**
 * Checkbox (design-admin-ui.md, "The components") on Reka's CheckboxRoot,
 * which renders a <button role="checkbox">. PrimeVue's prop names: `inputId`
 * becomes the button's id, so an external `<label for>` (or a wrapping
 * <label>) toggles and names it. `binary` is accepted for the swap and ignored:
 * the value is always a boolean. Attributes (data-testid, aria-*) land on the button.
 */
import { Check, Minus } from '@lucide/vue'
import { CheckboxRoot } from 'reka-ui'
import { computed } from 'vue'

const props = defineProps<{
  modelValue?: boolean
  indeterminate?: boolean
  inputId?: string
  binary?: boolean
  disabled?: boolean
  name?: string
}>()

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

const state = computed(() => (props.indeterminate ? 'indeterminate' : !!props.modelValue))
</script>

<template>
  <CheckboxRoot
    :id="inputId"
    class="ui-checkbox"
    :model-value="state"
    :disabled="disabled"
    :name="name"
    @update:model-value="v => emit('update:modelValue', v === true)"
  >
    <Minus v-if="indeterminate" class="ui-checkbox-icon" aria-hidden="true" />
    <Check v-else-if="modelValue" class="ui-checkbox-icon" aria-hidden="true" />
  </CheckboxRoot>
</template>

<style scoped>
.ui-checkbox {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  inline-size: 1.125rem;
  block-size: 1.125rem;
  padding: 0;
  border: 1px solid var(--color-muted);
  border-radius: var(--radius-sm);
  background: var(--color-input-bg);
  color: var(--color-on-primary);
  cursor: pointer;
}
.ui-checkbox[data-state='checked'],
.ui-checkbox[data-state='indeterminate'] {
  border-color: var(--color-primary);
  background: var(--color-primary);
}
.ui-checkbox:hover:not(:disabled) {
  border-color: var(--color-primary);
}
.ui-checkbox:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.ui-checkbox:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.ui-checkbox-icon {
  inline-size: 0.875rem;
  block-size: 0.875rem;
  stroke-width: 3;
}
</style>
