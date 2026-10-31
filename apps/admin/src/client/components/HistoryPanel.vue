<script setup lang="ts">
/**
 * History panel — per-target list of revisions with Restore on each row.
 *
 * Design (design-editor-ux.md "Undo and rollback"):
 *   "Target history panel. Click a target in the top bar to open its
 *    history — a list of revisions with timestamp, author, operation,
 *    and affected items. Each row has a Restore action that creates a
 *    new revision matching that past state. Rollback is just restore
 *    to an older revision."
 *
 * Opens as a modal over the workspace. Restoring a revision on the
 * currently-active target triggers the same post-restore reset as the
 * save-toast Undo (clear editing state, reload site + selection,
 * refresh sync status).
 */
import { CircleAlert, CloudUpload, RefreshCw, Save } from '@lucide/vue'
import { type Component, computed, ref, watch } from 'vue'
import Dialog from './ui/Dialog.vue'
import Button from './ui/Button.vue'
import Spinner from './ui/Spinner.vue'
import type { RevisionSummary } from '../api/client.js'
import { useHistoryApi } from '../composables/api.js'
import { useActiveTargetStore } from '../stores/activeTarget.js'
import { useSyncStatusStore } from '../stores/syncStatus.js'
import { useEditingStore } from '../stores/editing.js'
import { useToastStore } from '../stores/toast.js'

const historyApi = useHistoryApi()

const props = defineProps<{
  visible: boolean
  /** Target to show history for. Defaults to active target. */
  target?: string
}>()
const emit = defineEmits<{ (e: 'update:visible', v: boolean): void }>()

const activeTarget = useActiveTargetStore()
const syncStatus = useSyncStatusStore()
const editing = useEditingStore()
const toast = useToastStore()

const targetName = computed(() => props.target ?? activeTarget.activeTargetName ?? null)

const revisions = ref<RevisionSummary[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const restoringId = ref<string | null>(null)

async function load() {
  if (!targetName.value) {
    revisions.value = []
    return
  }
  loading.value = true
  error.value = null
  try {
    const res = await historyApi.listHistory(targetName.value)
    revisions.value = res.revisions
  } catch (err) {
    error.value = (err as Error).message
    revisions.value = []
  } finally {
    loading.value = false
  }
}

// Reload whenever the panel opens OR the target changes while open.
watch(
  () => [props.visible, targetName.value],
  ([v]) => {
    if (v) load()
  },
)

function close() {
  emit('update:visible', false)
}

async function onRestore(id: string) {
  if (!targetName.value || restoringId.value) return
  restoringId.value = id
  try {
    await historyApi.restoreRevision(targetName.value, id)
    // If we restored the active target, the admin's cached content +
    // editor form are stale — reuse the same refresh the save-toast
    // Undo uses so both entry points behave identically. For other
    // targets, only the sync chip's changed-count is stale.
    if (targetName.value === activeTarget.activeTargetName) {
      await editing.refreshAfterRestore()
    }
    syncStatus.invalidate(targetName.value)
    syncStatus.refreshOne(targetName.value)
    await load()
    toast.show(`Restored ${id}`)
  } catch (err) {
    toast.showError(err, `Restore failed for ${id}`)
  } finally {
    restoringId.value = null
  }
}

function friendlyTime(iso: string): string {
  const now = Date.now()
  const ts = new Date(iso).getTime()
  const diff = now - ts
  const s = Math.round(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}

function operationIcon(op: RevisionSummary['operation']): Component {
  if (op === 'save') return Save
  if (op === 'publish') return CloudUpload
  return RefreshCw // rollback
}

function operationLabel(op: RevisionSummary['operation']): string {
  if (op === 'save') return 'Save'
  if (op === 'publish') return 'Publish'
  return 'Rollback'
}

function itemsSummary(rev: RevisionSummary): string {
  if (rev.items.length === 0) return '(no items)'
  if (rev.items.length <= 3) return rev.items.join(', ')
  return `${rev.items.slice(0, 3).join(', ')} · +${rev.items.length - 3} more`
}

/**
 * True when this revision is the current head — restoring to head is
 * a valid no-op (soft undo invariant), but the button's meaningless
 * to the author so disable it.
 */
function isHead(rev: RevisionSummary): boolean {
  return revisions.value[0]?.id === rev.id
}
</script>

<template>
  <Dialog :visible="props.visible" @update:visible="v => emit('update:visible', v)"
    modal dismissableMask :closable="true"
    :header="`History — ${targetName ?? '(no target)'}`"
    :style="{ width: '620px', maxWidth: '95vw' }"
    data-testid="history-panel">
    <div v-if="loading && revisions.length === 0" class="state-loading" data-testid="history-loading">
      <Spinner strokeWidth="4" />
      <span>Loading revisions…</span>
    </div>
    <div v-else-if="error" class="state-error" data-testid="history-error">
      <CircleAlert class="state-icon" aria-hidden="true" />
      <span>{{ error }}</span>
    </div>
    <div v-else-if="revisions.length === 0" class="state-empty" data-testid="history-empty">
      No revisions on this target yet — saves and publishes will record here.
    </div>
    <ul v-else class="revisions" data-testid="history-list">
      <li v-for="rev in revisions" :key="rev.id"
        class="revision"
        :data-testid="`history-row-${rev.id}`">
        <component :is="operationIcon(rev.operation)" class="op-icon" aria-hidden="true" />
        <div class="meta">
          <div class="head-row">
            <span class="op-label">{{ operationLabel(rev.operation) }}</span>
            <span v-if="rev.source" class="source">from {{ rev.source }}</span>
            <span v-if="isHead(rev)" class="head-badge">current</span>
            <span class="time" :title="rev.timestamp">{{ friendlyTime(rev.timestamp) }}</span>
          </div>
          <div v-if="rev.message" class="message">{{ rev.message }}</div>
          <div class="items" :title="rev.items.join('\n')">{{ itemsSummary(rev) }}</div>
        </div>
        <Button
          label="Restore"
          size="small"
          severity="secondary"
          :disabled="isHead(rev) || !!restoringId"
          :loading="restoringId === rev.id"
          :data-testid="`history-restore-${rev.id}`"
          @click="onRestore(rev.id)" />
      </li>
    </ul>

    <template #footer>
      <Button label="Close" severity="secondary" @click="close" data-testid="history-panel-close" />
    </template>
  </Dialog>
</template>

<style scoped>
.state-loading,
.state-error,
.state-empty {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 1rem;
  font-size: 0.875rem;
  color: var(--color-muted);
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-sm);
}
.state-error { color: var(--color-danger-fg); border-color: var(--color-danger-fg); }

.revisions {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  max-height: 60vh;
  overflow: auto;
}
.revision {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: start;
  gap: 0.75rem;
  padding: 0.625rem 0.75rem;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
}
.state-icon {
  inline-size: 1rem;
  block-size: 1rem;
  flex: none;
}
.op-icon {
  inline-size: 0.875rem;
  block-size: 0.875rem;
  margin-top: 0.125rem;
  color: var(--color-muted);
}
.meta {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 0;
}
.head-row {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  flex-wrap: wrap;
  font-size: 0.8125rem;
}
.op-label { font-weight: 600; }
.source {
  font-size: 0.75rem;
  color: var(--color-muted);
  font-weight: 500;
}
.head-badge {
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 0.125rem 0.375rem;
  border-radius: var(--radius-xs);
  background: var(--color-info-bg);
  color: var(--color-info-fg);
  font-weight: 600;
}
.time {
  font-size: 0.75rem;
  color: var(--color-muted);
  font-variant-numeric: tabular-nums;
  margin-left: auto;
}
.message {
  font-size: 0.8125rem;
  color: var(--color-muted);
  font-style: italic;
}
.items {
  font-size: 0.75rem;
  color: var(--color-muted);
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
