<script setup lang="ts">
/**
 * TextInput (design-admin-ui.md, "The components"): a native <input> with
 * PrimeVue InputText's `v-model` and `size="small"`. Every other attribute
 * (id, placeholder, list, data-testid, class) lands on the <input>.
 */
defineProps<{ size?: 'small' }>()
const model = defineModel<string | null | undefined>()
</script>

<template>
  <input v-model="model" type="text" class="ui-text-input" :class="{ 'ui-text-input--small': size === 'small' }" />
</template>

<style scoped>
.ui-text-input {
  box-sizing: border-box;
  padding-block: 0.5rem;
  padding-inline: 0.75rem;
  border: 1px solid var(--color-input-border);
  border-radius: var(--radius-md);
  background: var(--color-input-bg);
  color: var(--color-fg);
  font: inherit;
  font-size: 0.875rem;
  line-height: 1.25rem;
}
.ui-text-input::placeholder {
  color: var(--color-muted);
}
.ui-text-input:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: 0;
  border-color: var(--color-focus-ring);
}
.ui-text-input:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.ui-text-input--small {
  padding-block: 0.3125rem;
  padding-inline: 0.5rem;
  font-size: 0.8125rem;
}
</style>
