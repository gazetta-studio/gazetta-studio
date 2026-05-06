<script setup lang="ts">
/**
 * Field-by-field semantic diff for the conflict banner per
 * `design-offline.md` Q3.
 *
 * v1 scope: walk the union of top-level keys; for each, show:
 *
 *   - **Primitive** (string/number/bool/null): "Title: 'Mine' vs.
 *     'Theirs'" — explicit comparison
 *   - **Object/array** (changed): "(changes inside)" — author opens
 *     the editor to see details
 *   - **Only in one side**: "(only in mine)" / "(only in theirs)"
 *
 * Recursive deep diff is v1.5 — explicitly deferred per design-offline.md
 * because for v1 the goal is "author understands at a glance whether
 * to discard or rebase," not "author resolves field-by-field in
 * the diff view." Most pages have <5 changed top-level fields; the
 * shallow view scales fine.
 *
 * Modal-y inline panel inside the banner — not a full PrimeVue Dialog
 * because the banner is already a strong surface and embedding the
 * diff inside it keeps focus close to the actions.
 */
import { computed } from 'vue'
import Button from 'primevue/button'

const props = defineProps<{
  current: Record<string, unknown>
  pending: Record<string, unknown>
}>()

defineEmits<{
  close: []
}>()

interface DiffRow {
  key: string
  /**
   * Label is the field name with humanization for known keys
   * (`metadata` → "Metadata"; `route` → "Route"). Unknown keys
   * pass through unchanged.
   */
  label: string
  pending: string
  current: string
  /** Same on both sides — informational; not actionable. Hidden
   *  from the diff view to keep the surface to "what changed." */
  unchanged: boolean
}

const KNOWN_FIELDS: Record<string, string> = {
  template: 'Template',
  route: 'Route',
  metadata: 'Metadata',
  content: 'Content',
  components: 'Components',
}

function describeValue(v: unknown): string {
  if (v === null) return 'null'
  if (v === undefined) return '(unset)'
  if (typeof v === 'string') return v.length > 60 ? `${v.slice(0, 57)}…` : v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? '' : 's'}`
  if (typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>)
    return keys.length === 0 ? '(empty)' : `${keys.length} field${keys.length === 1 ? '' : 's'}`
  }
  return String(v)
}

function isPrimitive(v: unknown): boolean {
  return v === null || v === undefined || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
}

function rowFor(key: string): DiffRow {
  const inPending = key in props.pending
  const inCurrent = key in props.current
  const p = props.pending[key]
  const c = props.current[key]
  const label = KNOWN_FIELDS[key] ?? key

  if (!inPending && inCurrent) {
    return { key, label, pending: '(only in theirs)', current: describeValue(c), unchanged: false }
  }
  if (inPending && !inCurrent) {
    return { key, label, pending: describeValue(p), current: '(only in mine)', unchanged: false }
  }
  if (isPrimitive(p) && isPrimitive(c)) {
    return {
      key,
      label,
      pending: describeValue(p),
      current: describeValue(c),
      unchanged: p === c,
    }
  }
  // Both sides are objects/arrays — shallow comparison; if the JSON
  // canonicalizes the same, treat as unchanged.
  const pJson = JSON.stringify(p)
  const cJson = JSON.stringify(c)
  if (pJson === cJson) {
    return { key, label, pending: describeValue(p), current: describeValue(c), unchanged: true }
  }
  return {
    key,
    label,
    pending: `${describeValue(p)} (changes inside)`,
    current: `${describeValue(c)} (changes inside)`,
    unchanged: false,
  }
}

const rows = computed<DiffRow[]>(() => {
  const keys = new Set([...Object.keys(props.pending), ...Object.keys(props.current)])
  return [...keys].map(rowFor).filter(r => !r.unchanged)
})
</script>

<template>
  <div class="diff-view" data-testid="conflict-diff-view">
    <div class="diff-header">
      <strong>What changed</strong>
      <Button
        icon="pi pi-times"
        text
        rounded
        size="small"
        severity="secondary"
        aria-label="Close diff view"
        data-testid="conflict-diff-close"
        @click="$emit('close')" />
    </div>
    <p v-if="rows.length === 0" class="diff-empty" data-testid="conflict-diff-empty">
      No top-level differences detected.
    </p>
    <table v-else class="diff-table">
      <thead>
        <tr>
          <th>Field</th>
          <th>Yours</th>
          <th>Theirs</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.key" :data-testid="`conflict-diff-row-${row.key}`">
          <td class="diff-label">{{ row.label }}</td>
          <td class="diff-cell diff-pending" :data-testid="`conflict-diff-pending-${row.key}`">
            {{ row.pending }}
          </td>
          <td class="diff-cell diff-current" :data-testid="`conflict-diff-current-${row.key}`">
            {{ row.current }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.diff-view {
  margin-top: 0.75rem;
  background: var(--color-bg);
  color: var(--color-fg);
  border: 1px solid var(--color-border);
  border-radius: var(--p-border-radius-sm);
  padding: 0.75rem;
}
.diff-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.5rem;
}
.diff-empty {
  margin: 0.25rem 0 0;
  font-size: 0.875rem;
  color: var(--color-muted);
}
.diff-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}
.diff-table th {
  text-align: start;
  font-weight: 600;
  padding: 0.25rem 0.5rem;
  border-bottom: 1px solid var(--color-border);
}
.diff-table td {
  padding: 0.25rem 0.5rem;
  border-bottom: 1px solid var(--color-border);
  vertical-align: top;
}
.diff-label {
  font-weight: 500;
  white-space: nowrap;
}
.diff-cell {
  font-family: ui-monospace, monospace;
  font-size: 0.8125rem;
  word-break: break-word;
}
</style>
