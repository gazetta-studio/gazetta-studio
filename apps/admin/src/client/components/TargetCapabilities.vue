<script setup lang="ts">
/**
 * "About this target": what a target keeps and can do
 * (design-public-storage.md, UX check, "Capabilities view"). The rows and
 * their wording come from the server (`TargetInfo.about`, the same rows
 * `gazetta targets` prints); this dialog only renders them.
 */
import Dialog from './ui/Dialog.vue'
import Button from './ui/Button.vue'
import type { TargetInfo } from '../api/client.js'

const props = defineProps<{ visible: boolean; target: TargetInfo | null }>()
const emit = defineEmits<{ (e: 'update:visible', v: boolean): void }>()

/** Names in the copy are wrapped in backticks; show them as code. */
function segments(value: string): Array<{ text: string; code: boolean }> {
  return value.split('`').map((text, i) => ({ text, code: i % 2 === 1 }))
}
</script>

<template>
  <Dialog :visible="props.visible" @update:visible="v => emit('update:visible', v)"
    modal dismissableMask
    :header="`About ${props.target?.name ?? 'this target'}`"
    :style="{ width: '520px', maxWidth: '95vw' }"
    data-testid="target-capabilities">
    <dl class="rows">
      <div v-for="row in props.target?.about ?? []" :key="row.key"
        class="row" :data-testid="`target-capability-${row.key}`">
        <dt>{{ row.label }}</dt>
        <dd><template v-for="(seg, i) in segments(row.value)" :key="i"><code v-if="seg.code">{{ seg.text }}</code><template v-else>{{ seg.text }}</template></template></dd>
      </div>
    </dl>
    <template #footer>
      <Button label="Close" severity="secondary" data-testid="target-capabilities-close"
        @click="emit('update:visible', false)" />
    </template>
  </Dialog>
</template>

<style scoped>
.rows {
  margin: 0;
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.5rem 1rem;
  font-size: 0.875rem;
}
.row {
  display: contents;
}
dt {
  color: var(--color-muted);
}
dd {
  margin: 0;
  color: var(--color-fg);
}
code {
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  padding: 0 0.25rem;
  border-radius: var(--radius-xs);
  background: var(--color-bg-code);
}
</style>
