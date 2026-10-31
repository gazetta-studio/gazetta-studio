<script setup lang="ts">
/**
 * Toolbar (design-admin-ui.md, "The components") on Reka's ToolbarRoot, with
 * PrimeVue's slots: `#start`, `#center` and `#end`. Attributes (class,
 * aria-label, data-testid) land on the root.
 */
import { ToolbarRoot } from 'reka-ui'
</script>

<template>
  <ToolbarRoot class="ui-toolbar">
    <div class="ui-toolbar-group ui-toolbar-start"><slot name="start" /></div>
    <div class="ui-toolbar-group ui-toolbar-center"><slot name="center" /></div>
    <div class="ui-toolbar-group ui-toolbar-end"><slot name="end" /></div>
  </ToolbarRoot>
</template>

<style scoped>
.ui-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.5rem;
  padding-block: 0.5rem;
  padding-inline: 0.75rem;
  background: var(--color-bg);
  color: var(--color-fg);
  border-block-end: 1px solid var(--color-border);
}
.ui-toolbar-group {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-inline-size: 0;
}
.ui-toolbar-center {
  flex: 1;
  justify-content: center;
}
</style>
