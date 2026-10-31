<script setup lang="ts">
/**
 * Listbox (design-admin-ui.md, "The components") on Reka's Listbox: a single
 * select list with arrow keys, Home/End and type-ahead. PrimeVue's props:
 * `options` with `optionLabel` / `optionValue` (property names; without them
 * an option is its own label and value). Clicking the selected option clears
 * the selection to `null`, as PrimeVue does. `class` and `style` (e.g.
 * maxHeight) go on the scrolling box; other attributes (aria-label,
 * aria-labelledby, data-testid) on the role="listbox" element.
 */
import { Check } from '@lucide/vue'
import { ListboxContent, ListboxItem, ListboxItemIndicator, ListboxRoot } from 'reka-ui'
import { computed, useAttrs } from 'vue'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  // `any`: matches PrimeVue's types, so typed handlers at call sites still type-check.
  options?: readonly any[]
  optionLabel?: string
  optionValue?: string
  modelValue?: any
}>()

const emit = defineEmits<{ 'update:modelValue': [value: any] }>()

const attrs = useAttrs()
const contentAttrs = computed(() => {
  const { class: _class, style: _style, ...rest } = attrs
  return rest
})

const labelOf = (option: any): string =>
  props.optionLabel ? String(option?.[props.optionLabel] ?? '') : String(option ?? '')
const valueOf = (option: any): any => (props.optionValue ? option?.[props.optionValue] : option)
</script>

<template>
  <ListboxRoot
    class="ui-listbox"
    :class="attrs.class"
    :style="attrs.style"
    :model-value="modelValue ?? undefined"
    @update:model-value="v => emit('update:modelValue', v ?? null)"
  >
    <ListboxContent class="ui-listbox-content" v-bind="contentAttrs">
      <ListboxItem
        v-for="(option, i) in options ?? []"
        :key="i"
        class="ui-listbox-option"
        :value="valueOf(option)"
      >
        <span class="ui-listbox-label">{{ labelOf(option) }}</span>
        <ListboxItemIndicator class="ui-listbox-check">
          <Check aria-hidden="true" />
        </ListboxItemIndicator>
      </ListboxItem>
    </ListboxContent>
  </ListboxRoot>
</template>

<style scoped>
.ui-listbox {
  overflow-y: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-input-bg);
}
.ui-listbox-content {
  display: flex;
  flex-direction: column;
  padding: 0.25rem;
  outline: none;
}
.ui-listbox:has(.ui-listbox-content:focus-visible) {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.ui-listbox-option {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding-block: 0.375rem;
  padding-inline: 0.625rem;
  border-radius: var(--radius-sm);
  color: var(--color-fg);
  font-size: 0.875rem;
  line-height: 1.25rem;
  cursor: pointer;
  user-select: none;
}
.ui-listbox-option[data-highlighted] {
  background: var(--color-hover-bg);
}
.ui-listbox-option[data-state='checked'] {
  background: var(--color-primary);
  color: var(--color-on-primary);
}
.ui-listbox-label {
  flex: 1;
  min-inline-size: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ui-listbox-check {
  display: inline-flex;
}
.ui-listbox-check svg {
  inline-size: 1rem;
  block-size: 1rem;
}
</style>
