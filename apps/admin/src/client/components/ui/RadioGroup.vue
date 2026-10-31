<script setup lang="ts">
/**
 * RadioGroup (design-admin-ui.md, "The components") on Reka's RadioGroupRoot:
 * holds the `v-model` that PrimeVue's separate RadioButtons shared. Items
 * (RadioGroupItem) can sit anywhere inside, next to their own labels. Arrow
 * keys move between items and select them; attributes land on the
 * role="radiogroup" element, which needs an accessible name (aria-label or
 * aria-labelledby) when the group has no visible legend.
 */
import { RadioGroupRoot } from 'reka-ui'

defineProps<{
  // `any`: matches PrimeVue's `any`, so typed handlers at call sites still type-check.
  modelValue?: any
  name?: string
}>()

// `any`: see modelValue.
const emit = defineEmits<{ 'update:modelValue': [value: any] }>()
</script>

<template>
  <RadioGroupRoot
    class="ui-radio-group"
    :model-value="modelValue"
    :name="name"
    @update:model-value="v => emit('update:modelValue', v)"
  >
    <slot />
  </RadioGroupRoot>
</template>
