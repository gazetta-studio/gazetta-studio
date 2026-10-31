<script setup lang="ts">
/**
 * Item list for the Publish panel. One row per item that differs from at
 * least one destination. Each row:
 *   - Summary marker (+ added, ● modified, − deleted)
 *   - Checkbox (checked = include in publish; defaults to all)
 *   - Path
 *   - Fragment-only blast-radius badge (uses R36's component)
 *   - Per-destination state ("staging: modified", "prod: in sync")
 *
 * Selection is lifted via v-model:selected so the parent panel knows
 * the item set to publish.
 */
import { CircleAlert } from '@lucide/vue'
import { computed, watch } from 'vue'
import Checkbox from './ui/Checkbox.vue'
import Spinner from './ui/Spinner.vue'
import FragmentBlastRadius from './FragmentBlastRadius.vue'
import { usePublishItems, type ItemRow, type ItemChangeKind } from '../composables/usePublishItems.js'

const props = defineProps<{
  source: string | null
  destinations: string[]
  /** Items currently checked. Mirrors v-model:selected on the parent. */
  selected: Set<string>
}>()
const emit = defineEmits<{ (e: 'update:selected', v: Set<string>): void }>()

const { items, loading, error } = usePublishItems(
  () => props.source,
  () => props.destinations,
)

// When items re-compute (source/destinations changed), default to selecting
// every item with changes. Parent can still toggle individual ones.
watch(items, rows => {
  const next = new Set<string>()
  for (const r of rows) if (r.hasChanges) next.add(r.path)
  emit('update:selected', next)
})

function isFragment(path: string): string | null {
  return path.startsWith('fragments/') ? path.slice('fragments/'.length) : null
}

function markerClass(kind: ItemChangeKind): string {
  return `marker marker-${kind}`
}
function markerSymbol(kind: ItemChangeKind): string {
  if (kind === 'added') return '+'
  if (kind === 'deleted') return '−'
  if (kind === 'modified') return '●'
  return ''
}

function toggle(path: string, included: boolean) {
  const next = new Set(props.selected)
  if (included) next.add(path)
  else next.delete(path)
  emit('update:selected', next)
}

function selectAll() {
  const next = new Set<string>()
  for (const r of items.value) if (r.hasChanges) next.add(r.path)
  emit('update:selected', next)
}
function selectNone() {
  emit('update:selected', new Set())
}

const summary = computed(() => {
  const rows = items.value
  const mod = rows.filter(r => r.summary === 'modified').length
  const add = rows.filter(r => r.summary === 'added').length
  const del = rows.filter(r => r.summary === 'deleted').length
  const parts: string[] = []
  if (mod) parts.push(`${mod} modified`)
  if (add) parts.push(`${add} added`)
  if (del) parts.push(`${del} deleted`)
  return parts.join(' · ')
})

function rowState(item: ItemRow, dest: string): ItemChangeKind {
  return item.byDestination[dest] ?? 'unchanged'
}
function rowStateLabel(kind: ItemChangeKind): string {
  if (kind === 'added') return 'added'
  if (kind === 'deleted') return 'deleted'
  if (kind === 'modified') return 'modified'
  return 'in sync'
}
</script>

<template>
  <div class="publish-item-list" data-testid="publish-item-list">
    <!-- Header: summary + select all/none -->
    <div v-if="items.length > 0" class="list-header">
      <span class="summary" data-testid="publish-items-summary">{{ summary || 'no changes' }}</span>
      <div class="list-actions">
        <button type="button" class="link-btn" data-testid="publish-select-all" @click="selectAll">Select all</button>
        <span class="sep">·</span>
        <button type="button" class="link-btn" data-testid="publish-select-none" @click="selectNone">Select none</button>
      </div>
    </div>

    <!-- Body -->
    <div v-if="loading && items.length === 0" class="state-loading" data-testid="publish-items-loading">
      <Spinner strokeWidth="4" />
      <span>Comparing…</span>
    </div>
    <div v-else-if="error" class="state-error" data-testid="publish-items-error">
      <CircleAlert class="state-icon" aria-hidden="true" />
      <span>{{ error }}</span>
    </div>
    <div v-else-if="items.length === 0 && destinations.length > 0" class="state-empty"
      data-testid="publish-items-empty">
      Nothing to publish — all selected destinations are in sync.
    </div>
    <div v-else-if="destinations.length === 0" class="state-empty">
      Pick a destination above to see items.
    </div>
    <ul v-else class="items">
      <li v-for="item in items" :key="item.path"
        :class="['item', `item-${item.summary}`]"
        :data-testid="`publish-item-${item.path}`">
        <span :class="markerClass(item.summary)" aria-hidden="true">{{ markerSymbol(item.summary) }}</span>
        <Checkbox
          v-if="item.summary !== 'deleted'"
          :modelValue="selected.has(item.path)"
          @update:modelValue="(v: boolean) => toggle(item.path, v)"
          :inputId="`pub-${item.path}`"
          :aria-label="`Publish ${item.path}`"
        />
        <span v-else class="deleted-spacer" aria-hidden="true" />
        <span class="path">{{ item.path }}</span>
        <FragmentBlastRadius
          v-if="isFragment(item.path)"
          :fragmentName="isFragment(item.path)!"
        />
        <span class="by-dest">
          <span v-for="dest in destinations" :key="dest"
            :class="['dest-state', `dest-state-${rowState(item, dest)}`]">
            <span class="dest-name">{{ dest }}</span>
            <span class="dest-label">{{ rowStateLabel(rowState(item, dest)) }}</span>
          </span>
        </span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.publish-item-list {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
  width: 100%;
}

.list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 0.75rem;
  color: var(--color-muted);
}
.summary {
  font-variant-numeric: tabular-nums;
}
.list-actions {
  display: flex;
  gap: 0.375rem;
  align-items: center;
}
.link-btn {
  background: none;
  border: 0;
  padding: 0;
  font: inherit;
  color: var(--color-primary);
  cursor: pointer;
}
.link-btn:hover { text-decoration: underline; }
.sep { color: var(--color-border); }

.state-loading, .state-error, .state-empty {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8125rem;
  color: var(--color-muted);
  padding: 0.75rem;
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-sm);
}
.state-icon {
  inline-size: 1rem;
  block-size: 1rem;
  flex: none;
}
.state-error {
  color: var(--color-danger-fg);
  border-color: var(--color-danger-fg);
}

.items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  max-height: 50vh;
  overflow: auto;
}
.item {
  display: grid;
  grid-template-columns: 1.25rem auto 1fr auto auto;
  align-items: center;
  gap: 0.625rem;
  padding: 0.375rem 0.5rem;
  border-radius: var(--radius-sm);
  font-size: 0.875rem;
}
.item:hover { background: var(--color-hover-bg); }

.marker {
  font-weight: 700;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.marker-added { color: var(--color-success-fg); }
.marker-modified { color: var(--color-warning-fg); }
.marker-deleted { color: var(--color-danger-fg); }
.marker-unchanged { color: var(--color-muted); opacity: 0.4; }

.deleted-spacer {
  display: inline-block;
  width: 1.125rem;
  height: 1px;
}

.path {
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-deleted .path {
  text-decoration: line-through;
  opacity: 0.6;
}

.by-dest {
  display: flex;
  gap: 0.25rem;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.dest-state {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.6875rem;
  padding: 0.0625rem 0.375rem;
  border-radius: var(--radius-xs);
  border: 1px solid var(--color-border);
  color: var(--color-muted);
}
.dest-name {
  font-weight: 500;
}
.dest-label {
  opacity: 0.75;
}
.dest-state-added { color: var(--color-success-fg); border-color: var(--color-success-fg); }
.dest-state-modified { color: var(--color-warning-fg); border-color: var(--color-warning-fg); }
.dest-state-deleted { color: var(--color-danger-fg); border-color: var(--color-danger-fg); }
.dest-state-unchanged { opacity: 0.5; }
</style>
