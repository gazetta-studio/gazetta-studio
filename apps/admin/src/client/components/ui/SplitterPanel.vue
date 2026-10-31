<script setup lang="ts">
/**
 * SplitterPanel with PrimeVue's prop names: `size` is the initial size and
 * `minSize` the minimum, both in percent. Must sit directly in a Splitter,
 * which inserts the resize handles.
 */
import { SplitterPanel } from 'reka-ui'

defineProps<{ size?: number; minSize?: number }>()
</script>

<template>
  <SplitterPanel :default-size="size" :min-size="minSize ?? 0" class="ui-splitter-panel">
    <slot />
  </SplitterPanel>
</template>

<style scoped>
/* Reka sets `overflow: hidden` inline on each panel, which a caller's class
   (EditorView's `.cms-panel { overflow: auto }`) can't override. The admin's
   panels all scroll their content. */
.ui-splitter-panel {
  overflow: auto !important;
}
</style>
