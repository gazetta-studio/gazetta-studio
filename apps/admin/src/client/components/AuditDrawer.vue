<script setup lang="ts">
/**
 * Audit drawer — operator-facing surface for the forensic event log.
 *
 * Per design-audit.md "Audit drawer — query semantics" + Krug-aligned
 * UX rules from team-preferences.md rule 23: absence is a state;
 * universal language over jargon; no help-tooltips-as-bandaid.
 *
 * Renders the four states the route supports:
 *
 *   1. history-only (queryable provider, no external sinks):
 *      → inline events list; no link block
 *   2. history + external sinks with queryable + url:
 *      → events list + footer link "View full audit in {sink}"
 *   3. external-only with link (no queryable, has queryUrl):
 *      → empty events list + prominent message "Audit lives in
 *      {sink} — [link]"
 *   4. external-only without link (no queryable, no queryUrl):
 *      → message "Audit configured but not queryable. Configure
 *      history as a peer provider for in-admin browsing."
 *
 * Surfaces the standard filters: action / outcome / scopeKind /
 * scopeName / actor / time range / limit. Empty filter = all
 * events newest-first.
 *
 * Capability gating happens server-side on `read:audit-log`. The
 * drawer surfaces 401 / 403 as a clear error rather than silently
 * hiding events — operators need to know when their config blocks
 * the read.
 */
import { computed, ref, watch } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import Select from 'primevue/select'
import InputText from 'primevue/inputtext'
import ProgressSpinner from 'primevue/progressspinner'
import type {
  AuditAction,
  AuditEvent,
  AuditExternalSink,
  AuditOutcome,
  AuditQueryFilter,
  AuditScopeKind,
} from '../api/client.js'
import { useAuditApi } from '../composables/api.js'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{ (e: 'update:visible', v: boolean): void }>()

const auditApi = useAuditApi()

const events = ref<AuditEvent[]>([])
const externalSinks = ref<AuditExternalSink[]>([])
const loading = ref(false)
const error = ref<string | null>(null)

// Filters bound to the toolbar inputs.
const filterAction = ref<AuditAction | null>(null)
const filterOutcome = ref<AuditOutcome | null>(null)
const filterScopeKind = ref<AuditScopeKind | null>(null)
const filterActor = ref('')

const ACTION_OPTIONS: { value: AuditAction; label: string }[] = [
  { value: 'save', label: 'Save' },
  { value: 'publish', label: 'Publish' },
  { value: 'delete', label: 'Delete' },
  { value: 'restore', label: 'Restore' },
  { value: 'configure-roles', label: 'Configure roles' },
]
const OUTCOME_OPTIONS: { value: AuditOutcome; label: string }[] = [
  { value: 'success', label: 'Success' },
  { value: 'forbidden', label: 'Forbidden' },
  { value: 'validation-failed', label: 'Validation failed' },
  { value: 'unauthenticated', label: 'Unauthenticated' },
]
const SCOPE_KIND_OPTIONS: { value: AuditScopeKind; label: string }[] = [
  { value: 'page', label: 'Page' },
  { value: 'fragment', label: 'Fragment' },
  { value: 'asset', label: 'Asset' },
  { value: 'site', label: 'Site' },
]

async function load() {
  loading.value = true
  error.value = null
  const filter: AuditQueryFilter = {}
  if (filterAction.value) filter.action = filterAction.value
  if (filterOutcome.value) filter.outcome = filterOutcome.value
  if (filterScopeKind.value) filter.scopeKind = filterScopeKind.value
  if (filterActor.value.trim()) filter.actor = filterActor.value.trim()
  try {
    const res = await auditApi.queryAudit(filter)
    events.value = res.events
    externalSinks.value = res.externalSinks
  } catch (err) {
    error.value = (err as Error).message
    events.value = []
    externalSinks.value = []
  } finally {
    loading.value = false
  }
}

// Reload on open + on any filter change while open. `immediate: true`
// fires the initial load when the drawer mounts already-visible
// (the prop is `true` from the start; without immediate the watcher
// would wait for a change that never comes).
watch(
  [() => props.visible, filterAction, filterOutcome, filterScopeKind, filterActor],
  ([v]) => {
    if (v) load()
  },
  { immediate: true },
)

function close() {
  emit('update:visible', false)
}

function clearFilters() {
  filterAction.value = null
  filterOutcome.value = null
  filterScopeKind.value = null
  filterActor.value = ''
}

/**
 * Krug-aligned UX state derivation. The four states from the design
 * map onto:
 *
 *   - hasQueryableEvents: at least one queryable provider returned
 *     events (or empty result without external sinks)
 *   - sinksWithLinks: external-sink references that have a deep-link
 *   - sinksWithoutLinks: configured but not queryable, no link
 *
 * The UI composes:
 *
 *   - state 1 (history-only) → events render, no sink block
 *   - state 2 (mixed) → events + footer "Also in: {links}"
 *   - state 3 (external-only-with-link) → empty events list +
 *     prominent message + link
 *   - state 4 (external-only-no-link) → message-only state
 */
const sinksWithLinks = computed(() => externalSinks.value.filter(s => s.url !== null))
const sinksWithoutLinks = computed(() => externalSinks.value.filter(s => s.url === null))

const hasInlineEvents = computed(() => events.value.length > 0)
const hasOnlyExternal = computed(() => events.value.length === 0 && externalSinks.value.length > 0)

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

function actionIcon(action: AuditAction): string {
  if (action === 'save') return 'pi pi-save'
  if (action === 'publish') return 'pi pi-cloud-upload'
  if (action === 'delete') return 'pi pi-trash'
  if (action === 'restore') return 'pi pi-history'
  return 'pi pi-cog' // configure-roles
}

function outcomeBadgeClass(outcome: AuditOutcome): string {
  if (outcome === 'success') return 'outcome-success'
  if (outcome === 'validation-failed') return 'outcome-warn'
  return 'outcome-error' // forbidden, unauthenticated
}

function scopeLabel(event: AuditEvent): string {
  return event.scope.name ? `${event.scope.kind}/${event.scope.name}` : event.scope.kind
}
</script>

<template>
  <Dialog :visible="props.visible" @update:visible="v => emit('update:visible', v)"
    modal dismissableMask :closable="true"
    header="Audit log"
    :style="{ width: '720px', maxWidth: '95vw' }"
    data-testid="audit-drawer">
    <div class="filters" data-testid="audit-filters">
      <Select v-model="filterAction" :options="ACTION_OPTIONS" optionLabel="label" optionValue="value"
        placeholder="All actions" showClear size="small" data-testid="audit-filter-action" />
      <Select v-model="filterOutcome" :options="OUTCOME_OPTIONS" optionLabel="label" optionValue="value"
        placeholder="All outcomes" showClear size="small" data-testid="audit-filter-outcome" />
      <Select v-model="filterScopeKind" :options="SCOPE_KIND_OPTIONS" optionLabel="label" optionValue="value"
        placeholder="All scopes" showClear size="small" data-testid="audit-filter-scope" />
      <InputText v-model="filterActor" placeholder="Actor (id or email)" size="small"
        data-testid="audit-filter-actor" />
      <Button v-if="filterAction || filterOutcome || filterScopeKind || filterActor"
        icon="pi pi-filter-slash" size="small" severity="secondary"
        @click="clearFilters" aria-label="Clear filters" data-testid="audit-clear-filters" />
    </div>

    <div v-if="loading && events.length === 0" class="state-loading" data-testid="audit-loading">
      <ProgressSpinner style="width: 1.5rem; height: 1.5rem" strokeWidth="4" />
      <span>Loading events…</span>
    </div>
    <div v-else-if="error" class="state-error" data-testid="audit-error">
      <i class="pi pi-exclamation-circle" />
      <span>{{ error }}</span>
    </div>

    <!-- State 4: external-only without link — operator config note -->
    <div v-else-if="hasOnlyExternal && sinksWithLinks.length === 0"
      class="state-external-no-link"
      data-testid="audit-external-no-link">
      <p class="msg">
        Audit configured but not queryable in-admin.
      </p>
      <p class="hint">
        Configured providers: <strong>{{ sinksWithoutLinks.map(s => s.name).join(', ') }}</strong>.
        Configure <code>history</code> as a peer provider in
        <code>site.config.ts</code>'s <code>admin.audit.providers</code> for in-admin browsing.
      </p>
    </div>

    <!-- State 3: external-only with link — drive operator to the sink -->
    <div v-else-if="hasOnlyExternal && sinksWithLinks.length > 0"
      class="state-external-with-link"
      data-testid="audit-external-with-link">
      <p class="msg">Audit lives in your configured external sink.</p>
      <ul class="sink-links">
        <li v-for="sink in sinksWithLinks" :key="sink.name">
          <a :href="sink.url!" target="_blank" rel="noopener noreferrer"
            :data-testid="`audit-sink-link-${sink.name}`">
            View in {{ sink.name }}
            <i class="pi pi-external-link" aria-hidden="true" />
          </a>
        </li>
      </ul>
    </div>

    <!-- States 1 + 2: queryable events; sinks block appears in footer if any -->
    <div v-else-if="!hasInlineEvents" class="state-empty" data-testid="audit-empty">
      No matching events. Try clearing filters or widening the time range.
    </div>
    <ul v-else class="events" data-testid="audit-events">
      <li v-for="event in events" :key="`${event.timestamp}:${event.actor.id}:${event.action}:${event.scope.name ?? ''}`"
        class="event"
        :data-testid="`audit-event-${event.timestamp}`">
        <i :class="actionIcon(event.action)" class="action-icon" aria-hidden="true" />
        <div class="meta">
          <div class="head-row">
            <span class="action-label">{{ event.action }}</span>
            <span class="scope">{{ scopeLabel(event) }}</span>
            <span class="outcome" :class="outcomeBadgeClass(event.outcome)">{{ event.outcome }}</span>
            <span class="time" :title="event.timestamp">{{ friendlyTime(event.timestamp) }}</span>
          </div>
          <div class="actor">
            by <strong>{{ event.actor.email ?? event.actor.id }}</strong>
            <span class="role">({{ event.actor.role }})</span>
            <span v-if="event.actor.trustMode !== 'none'" class="trust-mode">
              via {{ event.actor.trustMode }}
            </span>
          </div>
          <div v-if="event.metadata" class="metadata-line">
            <span v-for="(value, key) in event.metadata" :key="key" class="metadata-pair">
              {{ key }}: <code>{{ String(value) }}</code>
            </span>
          </div>
        </div>
      </li>
    </ul>

    <!-- State 2: mixed — show sink links in the footer alongside inline events -->
    <div v-if="hasInlineEvents && sinksWithLinks.length > 0"
      class="footer-sinks"
      data-testid="audit-footer-sinks">
      <span class="footer-label">Also in:</span>
      <a v-for="sink in sinksWithLinks" :key="sink.name"
        :href="sink.url!" target="_blank" rel="noopener noreferrer"
        :data-testid="`audit-sink-link-${sink.name}`">
        {{ sink.name }} <i class="pi pi-external-link" aria-hidden="true" />
      </a>
    </div>

    <template #footer>
      <Button label="Close" severity="secondary" @click="close" data-testid="audit-drawer-close" />
    </template>
  </Dialog>
</template>

<style scoped>
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid var(--color-border);
  margin-bottom: 0.75rem;
}

.state-loading,
.state-error,
.state-empty,
.state-external-no-link,
.state-external-with-link {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 1rem;
  font-size: 0.875rem;
  color: var(--color-muted);
  border: 1px dashed var(--color-border);
  border-radius: var(--p-border-radius-sm);
}
.state-loading { flex-direction: row; align-items: center; }
.state-error { color: var(--color-danger-fg); border-color: var(--color-danger-fg); }
.state-external-no-link .msg,
.state-external-with-link .msg { font-weight: 600; color: var(--color-fg); }
.state-external-with-link .sink-links {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.state-external-with-link a,
.footer-sinks a {
  color: var(--color-primary);
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}
.state-external-with-link a:hover,
.footer-sinks a:hover { text-decoration: underline; }

.events {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  max-height: 60vh;
  overflow: auto;
}
.event {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.75rem;
  padding: 0.625rem 0.75rem;
  border-radius: var(--p-border-radius-sm);
  border: 1px solid var(--color-border);
}
.action-icon {
  font-size: 0.875rem;
  padding-top: 0.125rem;
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
.action-label {
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 0.6875rem;
}
.scope { color: var(--color-fg); }
.outcome {
  font-size: 0.6875rem;
  padding: 0.125rem 0.375rem;
  border-radius: var(--p-border-radius-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.outcome-success { background: var(--color-success-bg); color: var(--color-success-fg); }
.outcome-warn { background: var(--color-warning-bg); color: var(--color-warning-fg); }
.outcome-error { background: var(--color-danger-bg); color: var(--color-danger-fg); }
.time {
  font-size: 0.75rem;
  color: var(--color-muted);
  font-variant-numeric: tabular-nums;
  margin-left: auto;
}
.actor {
  font-size: 0.8125rem;
  color: var(--color-muted);
}
.role,
.trust-mode {
  font-size: 0.75rem;
  margin-left: 0.25rem;
}
.metadata-line {
  font-size: 0.75rem;
  color: var(--color-muted);
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 0.75rem;
}
.metadata-pair code {
  background: var(--color-hover-bg);
  padding: 0 0.25rem;
  border-radius: var(--p-border-radius-xs);
  font-family: ui-monospace, SFMono-Regular, monospace;
}

.footer-sinks {
  margin-top: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--color-border);
  font-size: 0.8125rem;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
}
.footer-label { color: var(--color-muted); }
</style>
