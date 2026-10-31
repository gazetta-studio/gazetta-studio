<script setup lang="ts">
/**
 * Select (design-admin-ui.md, "The components") on Reka's Select. PrimeVue's
 * props: `options` with `optionLabel` / `optionValue`, `placeholder`,
 * `showClear` (a separate clear button that emits `null`), `size="small"`.
 * `class` and `style` go on the wrapper; other attributes (data-testid,
 * aria-label, aria-labelledby) on the trigger the user clicks.
 *
 * Structure follows shadcn-vue's Select (https://github.com/unovue/shadcn-vue,
 * MIT, Copyright (c) 2023 unovue); styles are ours.
 */
import { Check, ChevronDown, X } from '@lucide/vue'
import {
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectPortal,
  SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectViewport,
} from 'reka-ui'
import { computed, useAttrs } from 'vue'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  // `any`: matches PrimeVue's types, so typed handlers at call sites still type-check.
  options?: readonly any[]
  optionLabel?: string
  optionValue?: string
  modelValue?: any
  placeholder?: string
  showClear?: boolean
  size?: 'small'
}>()

const emit = defineEmits<{ 'update:modelValue': [value: any] }>()

const attrs = useAttrs()
const triggerAttrs = computed(() => {
  const { class: _class, style: _style, ...rest } = attrs
  return rest
})
const testId = computed(() => attrs['data-testid'] as string | undefined)

const labelOf = (option: any): string =>
  props.optionLabel ? String(option?.[props.optionLabel] ?? '') : String(option ?? '')
const valueOf = (option: any): any => (props.optionValue ? option?.[props.optionValue] : option)

const hasValue = computed(() => props.modelValue !== null && props.modelValue !== undefined && props.modelValue !== '')
</script>

<template>
  <div
    class="ui-select"
    :class="[attrs.class, { 'ui-select--small': size === 'small', 'ui-select--clearable': showClear && hasValue }]"
    :style="attrs.style as any"
  >
    <SelectRoot
      :model-value="modelValue ?? undefined"
      @update:model-value="v => emit('update:modelValue', v)"
    >
      <SelectTrigger class="ui-select-trigger" v-bind="triggerAttrs">
        <SelectValue class="ui-select-value" :placeholder="placeholder" />
        <ChevronDown class="ui-select-chevron" aria-hidden="true" />
      </SelectTrigger>
      <SelectPortal>
        <SelectContent class="ui-select-content" position="popper" :side-offset="4">
          <SelectViewport class="ui-select-viewport">
            <SelectItem
              v-for="(option, i) in options ?? []"
              :key="i"
              class="ui-select-option"
              :value="valueOf(option)"
            >
              <SelectItemText>{{ labelOf(option) }}</SelectItemText>
              <SelectItemIndicator class="ui-select-check">
                <Check aria-hidden="true" />
              </SelectItemIndicator>
            </SelectItem>
          </SelectViewport>
        </SelectContent>
      </SelectPortal>
    </SelectRoot>
    <button
      v-if="showClear && hasValue"
      type="button"
      class="ui-select-clear"
      aria-label="Clear selection"
      :data-testid="testId ? `${testId}-clear` : undefined"
      @click="emit('update:modelValue', null)"
    >
      <X aria-hidden="true" />
    </button>
  </div>
</template>

<style scoped>
.ui-select {
  position: relative;
  display: inline-flex;
  min-inline-size: 10rem;
}
.ui-select-trigger {
  display: inline-flex;
  flex: 1;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  min-inline-size: 0;
  padding-block: 0.5rem;
  padding-inline: 0.75rem 0.5rem;
  border: 1px solid var(--color-input-border);
  border-radius: var(--radius-md);
  background: var(--color-input-bg);
  color: var(--color-fg);
  font: inherit;
  font-size: 0.875rem;
  line-height: 1.25rem;
  text-align: start;
  cursor: pointer;
}
.ui-select-trigger:hover {
  border-color: var(--color-muted);
}
.ui-select-trigger:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.ui-select-trigger[data-placeholder] .ui-select-value {
  color: var(--color-muted);
}
.ui-select-value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ui-select-chevron {
  inline-size: 1rem;
  block-size: 1rem;
  flex-shrink: 0;
  color: var(--color-muted);
}
.ui-select--clearable .ui-select-trigger {
  padding-inline-end: 2.25rem;
}
.ui-select-clear {
  position: absolute;
  inset-block: 0;
  inset-inline-end: 1.75rem;
  display: inline-flex;
  align-items: center;
  margin-block: auto;
  block-size: 1.5rem;
  padding-inline: 0.25rem;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-muted);
  cursor: pointer;
}
.ui-select-clear:hover {
  color: var(--color-fg);
  background: var(--color-hover-bg);
}
.ui-select-clear:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
}
.ui-select-clear svg {
  inline-size: 0.875rem;
  block-size: 0.875rem;
}
.ui-select--small .ui-select-trigger {
  padding-block: 0.3125rem;
  font-size: 0.8125rem;
}
</style>

<!-- Unscoped: the options are teleported to <body>, where Reka renders wrapper
     elements this component's scope id doesn't reach. Every class is prefixed. -->
<style>
.ui-select-content {
  z-index: 1200;
  min-inline-size: var(--reka-select-trigger-width);
  max-block-size: var(--reka-select-content-available-height);
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg);
  box-shadow: var(--shadow-overlay);
}
.ui-select-viewport {
  padding: 0.25rem;
}
.ui-select-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding-block: 0.375rem;
  padding-inline: 0.625rem;
  border-radius: var(--radius-sm);
  color: var(--color-fg);
  font-size: 0.875rem;
  line-height: 1.25rem;
  cursor: pointer;
  outline: none;
  user-select: none;
}
.ui-select-option[data-highlighted] {
  background: var(--color-hover-bg);
}
.ui-select-option[data-state='checked'] {
  font-weight: 600;
}
.ui-select-check {
  display: inline-flex;
  color: var(--color-primary);
}
.ui-select-check svg {
  inline-size: 1rem;
  block-size: 1rem;
}
</style>
