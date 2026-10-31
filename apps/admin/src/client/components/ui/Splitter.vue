<script setup lang="ts">
/**
 * Splitter (design-admin-ui.md, "The components") on Reka's SplitterGroup,
 * with PrimeVue's API: `<Splitter><SplitterPanel :size :minSize>…`. Like
 * PrimeVue, the gutter between panels is inserted here, so call sites write
 * only panels: the default slot's panel vnodes are rendered with a resize
 * handle before every panel but the first.
 */
import { SplitterGroup, SplitterResizeHandle } from 'reka-ui'
import { Comment, Fragment, ref, type VNode, useSlots } from 'vue'

withDefaults(defineProps<{ layout?: 'horizontal' | 'vertical' }>(), { layout: 'horizontal' })

const slots = useSlots()
const sizes = ref<number[]>([])

function minOf(panel: VNode): number {
  const p = panel.props ?? {}
  return Number(p.minSize ?? p['min-size'] ?? 0)
}

/**
 * The slot's panels (`v-for` fragments flattened, `v-if` placeholders dropped),
 * each with the bounds of the handle before it: the window-splitter pattern's
 * value is the size of the panel before the handle.
 */
function panels() {
  const flatten = (nodes: VNode[]): VNode[] =>
    nodes.flatMap(n => (n.type === Fragment ? flatten(n.children as VNode[]) : n.type === Comment ? [] : [n]))
  const list = flatten(slots.default?.() ?? [])
  return list.map((panel, i) => ({
    panel,
    handleMin: i > 0 ? minOf(list[i - 1] as VNode) : 0,
    handleMax: 100 - minOf(panel),
  }))
}
</script>

<template>
  <SplitterGroup :direction="layout" :keyboard-resize-by="5" class="ui-splitter" @layout="sizes = $event">
    <template v-for="({ panel, handleMin, handleMax }, i) in panels()" :key="i">
      <SplitterResizeHandle
        v-if="i > 0"
        class="ui-splitter-gutter"
        aria-label="Resize panels"
        :aria-orientation="layout === 'horizontal' ? 'vertical' : 'horizontal'"
        :aria-valuenow="sizes[i - 1] === undefined ? undefined : Math.round(sizes[i - 1])"
        :aria-valuemin="handleMin"
        :aria-valuemax="handleMax"
      >
        <span class="ui-splitter-grip" aria-hidden="true" />
      </SplitterResizeHandle>
      <component :is="panel" />
    </template>
  </SplitterGroup>
</template>

<style scoped>
.ui-splitter-gutter {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  inline-size: 1px;
  background: var(--color-border);
}
.ui-splitter-gutter[data-orientation='vertical'] {
  inline-size: auto;
  block-size: 1px;
}
/* A wider hit area than the 1px line, without shifting the layout. */
.ui-splitter-gutter::before {
  content: '';
  position: absolute;
  inset-block: 0;
  inset-inline: -4px;
}
.ui-splitter-gutter[data-orientation='vertical']::before {
  inset-block: -4px;
  inset-inline: 0;
}
.ui-splitter-grip {
  position: relative;
  z-index: 1;
  inline-size: 4px;
  block-size: 1.5rem;
  border-radius: var(--radius-full);
  background: var(--color-border);
}
.ui-splitter-gutter[data-orientation='vertical'] .ui-splitter-grip {
  inline-size: 1.5rem;
  block-size: 4px;
}
.ui-splitter-gutter:hover,
.ui-splitter-gutter[data-state='drag'],
.ui-splitter-gutter:hover .ui-splitter-grip,
.ui-splitter-gutter[data-state='drag'] .ui-splitter-grip {
  background: var(--color-muted);
}
.ui-splitter-gutter:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
</style>
