<script setup lang="ts">
/**
 * Unified Publish panel — the design-editor-ux.md surface that replaces
 * PublishDialog + FetchDialog + ChangesDrawer.
 *
 * Shape:
 *   - Source: where content is coming from (defaults to active target when
 *     editable, else first editable). Dropdown so the author can publish
 *     from staging → prod ("promote") without leaving the panel.
 *   - Destinations: multi-select across non-source targets. Mirrors the
 *     design's "fan-out" publish model.
 *   - Items: list of changed items (R38b), each with diff expansion.
 *   - Action: "Publish N → M" button runs the publish stream (R38c).
 *
 * This commit (R38a) lands the shell: source picker, destinations
 * checkboxes, empty item list placeholder, disabled action. R38b adds
 * the item list + diffs; R38c wires streaming publish; R38d deletes the
 * old dialogs.
 */

import { computed, ref, watch } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import Select from 'primevue/select'
import type { PublishResult, ValidationIssue } from '../api/client.js'
import { PublishAuditFailedError } from '../api/client.js'
import { usePublishApi, useHistoryApi } from '../composables/api.js'
import { useActiveTargetStore } from '../stores/activeTarget.js'
import { useSyncStatusStore } from '../stores/syncStatus.js'
import { useToastStore } from '../stores/toast.js'
import { groupedEntries, type TargetGroup } from '../composables/targetGrouping.js'
import PublishItemList from './PublishItemList.vue'

const publishApi = usePublishApi()
const historyApi = useHistoryApi()

const props = defineProps<{
  visible: boolean
  /** Optional initial destination pre-check (e.g., click sync chip → open panel). */
  initialDestination?: string
}>()
const emit = defineEmits<{ (e: 'update:visible', v: boolean): void }>()

const activeTarget = useActiveTargetStore()
const syncStatus = useSyncStatusStore()
const toast = useToastStore()

// --- Source selection -------------------------------------------------

const editableTargets = computed(() => activeTarget.editableTargets)

/** Default source: the active target when editable, else the first editable. */
function pickDefaultSource(): string | null {
  const active = activeTarget.activeTarget
  if (active?.editable) return active.name
  return editableTargets.value[0]?.name ?? null
}

const sourceName = ref<string | null>(null)

// Destinations: anything that isn't the source
const destinationOptions = computed(() => activeTarget.targets.filter(t => t.name !== sourceName.value))

const selectedDestinations = ref<Set<string>>(new Set())

function toggleDestination(name: string) {
  const next = new Set(selectedDestinations.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  selectedDestinations.value = next
}

/**
 * Destinations as grouped render entries. At ≤3 total targets the
 * picker stays flat (one row per destination, no group headers). At
 * 4+ it groups by environment, and multi-member groups render a
 * "select all" header checkbox that toggles every member at once —
 * design-editor-ux.md "Scaling to 4+ targets" + "Multi-destination
 * publish (fan-out)". The threshold lives in targetGrouping.ts so
 * every target-referencing surface renders consistently.
 *
 * Iteration order is preserved from target declaration order in
 * site.yaml, matching the top-bar switcher and sync indicators.
 */
const destinationEntries = computed(() => groupedEntries(destinationOptions.value, activeTarget.targets.length))

/** Tri-state of a group's selection: 'none' | 'some' | 'all'. */
function groupState(group: TargetGroup): 'none' | 'some' | 'all' {
  const selected = group.members.filter(m => selectedDestinations.value.has(m.name)).length
  if (selected === 0) return 'none'
  if (selected === group.members.length) return 'all'
  return 'some'
}

/** Toggle an entire group: if any member is unselected, select all; else deselect all. */
function toggleGroup(group: TargetGroup) {
  const next = new Set(selectedDestinations.value)
  const state = groupState(group)
  if (state === 'all') {
    for (const m of group.members) next.delete(m.name)
  } else {
    for (const m of group.members) next.add(m.name)
  }
  selectedDestinations.value = next
}

// Items selected for publish. Managed via v-model:selected on the list;
// list auto-populates when source/destinations change.
const selectedItems = ref<Set<string>>(new Set())

// Destination names as an array (PublishItemList takes string[]).
const destinationNames = computed(() => [...selectedDestinations.value])

// --- Publish execution (R38c) -----------------------------------------

interface TargetProgress {
  current: number
  total: number
  label: string
  status: 'pending' | 'in-progress' | 'done' | 'error'
}
const publishing = ref(false)
const confirming = ref(false)
const progress = ref(new Map<string, TargetProgress>())
const results = ref<PublishResult[] | null>(null)
const publishError = ref<string | null>(null)
const invalidTemplates = ref<{ name: string; errors: string[] }[]>([])
/** Destinations whose Undo was clicked — keeps the button latched
 *  disabled so the user can't accidentally double-rollback. */
const undoneTargets = ref(new Set<string>())

// --- Pre-publish audit (Validation Cut 4) -----------------------------
//
// When the user clicks Publish, we first call POST /api/publish/audit
// per destination to surface any pre-publish-stage validator issues.
// Errors always block the publish; warns can be "Ignored once" (per-
// publish-dialog state, not persisted — author opts out for THIS
// publish only). If a determined client bypasses the dialog the
// server-side gate at POST /api/publish refuses with the same
// PUBLISH_AUDIT_FAILED 409 (defense in depth).

interface AuditPerTarget {
  /** Destination this issue set applies to. */
  target: string
  /** True when the destination's publishAudit.strict is on (warns become errors). */
  strict: boolean
  /** Issues from runPublishAudit for this destination, in server order. */
  issues: ValidationIssue[]
}

const auditing = ref(false)
const auditState = ref<AuditPerTarget[] | null>(null)
/** Set of `${target}::${itemPath}::${validator}` keys the user opted to ignore. */
const ignoredWarns = ref<Set<string>>(new Set())

function auditIssueKey(target: string, issue: ValidationIssue): string {
  return `${target}::${issue.itemPath}::${issue.validator}::${issue.message}`
}

/** Convert publish-item-list paths (`pages/home`) to the kind+name shape
 *  the audit endpoint expects. Asset paths and unknown shapes are dropped
 *  (the audit only inspects pages + fragments). */
function pathsToAuditItems(paths: ReadonlyArray<string>): Array<{ kind: 'page' | 'fragment'; name: string }> {
  const out: Array<{ kind: 'page' | 'fragment'; name: string }> = []
  for (const p of paths) {
    if (p.startsWith('pages/')) out.push({ kind: 'page', name: p.slice('pages/'.length) })
    else if (p.startsWith('fragments/')) out.push({ kind: 'fragment', name: p.slice('fragments/'.length) })
  }
  return out
}

/** Errors always block; warns block only when user hasn't ticked "Ignore". */
function blockingIssueCount(state: ReadonlyArray<AuditPerTarget>): number {
  let n = 0
  for (const perTarget of state) {
    for (const issue of perTarget.issues) {
      if (issue.severity === 'error') n++
      else if (issue.severity === 'warn' && !ignoredWarns.value.has(auditIssueKey(perTarget.target, issue))) n++
    }
  }
  return n
}

const blockingIssueTotal = computed(() => (auditState.value ? blockingIssueCount(auditState.value) : 0))
const auditHasIssues = computed(() => !!auditState.value && auditState.value.some(t => t.issues.length > 0))

function toggleIgnoreWarn(target: string, issue: ValidationIssue) {
  if (issue.severity !== 'warn') return
  const key = auditIssueKey(target, issue)
  const next = new Set(ignoredWarns.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  ignoredWarns.value = next
}

function isWarnIgnored(target: string, issue: ValidationIssue): boolean {
  return ignoredWarns.value.has(auditIssueKey(target, issue))
}

/** Build the audit response into the AuditPerTarget[] state, dropping
 *  destinations that returned zero issues (clean targets don't gate). */
async function runPrePublishAudit(items: string[], dests: string[]): Promise<AuditPerTarget[]> {
  const auditItems = pathsToAuditItems(items)
  if (auditItems.length === 0) return []
  const out: AuditPerTarget[] = []
  for (const target of dests) {
    try {
      const res = await publishApi.publishAudit(target, auditItems)
      if (res.issues.length > 0) {
        out.push({ target, strict: res.strict, issues: res.issues })
      }
    } catch (err) {
      // Audit failures fail-open at the dialog — the server-side gate
      // remains. We surface a small toast so the author knows the
      // pre-flight check didn't run, but don't block.
      toast.showError(err, `Audit failed on ${target}`)
    }
  }
  return out
}

// Production destinations require explicit confirmation to avoid accidental
// pushes to live content — same pattern as the old PublishDialog.
const productionDestinations = computed(() =>
  activeTarget.targets.filter(t => t.environment === 'production' && selectedDestinations.value.has(t.name)),
)
const needsConfirm = computed(() => productionDestinations.value.length > 0)

function resetPublishState() {
  publishing.value = false
  confirming.value = false
  auditing.value = false
  auditState.value = null
  ignoredWarns.value = new Set()
  progress.value = new Map()
  results.value = null
  publishError.value = null
  invalidTemplates.value = []
  undoneTargets.value = new Set()
}

/**
 * Undo a publish to a specific destination. Rolls that target back to
 * its pre-publish revision (soft undo: recorded as a forward rollback).
 * Refreshes sync status so the chip reflects the post-undo state.
 */
async function undoPublish(targetName: string) {
  if (undoneTargets.value.has(targetName)) return
  try {
    await historyApi.undoLastWrite(targetName)
    const next = new Set(undoneTargets.value)
    next.add(targetName)
    undoneTargets.value = next
    syncStatus.invalidate(targetName)
    syncStatus.refreshOne(targetName)
    toast.show(`Undone on ${targetName}`)
  } catch (err) {
    toast.showError(err, `Undo failed on ${targetName}`)
  }
}

async function handlePublishClick() {
  if (!canPublish.value || publishing.value || auditing.value) return
  // Production confirmation: same as before, runs before audit.
  if (needsConfirm.value && !confirming.value) {
    confirming.value = true
    return
  }
  // If we're currently displaying audit issues, the click is the
  // "Continue" affordance — proceed directly to the publish stream
  // with whatever warns the user has acknowledged.
  if (auditState.value) {
    if (blockingIssueTotal.value > 0) return
    await runPublish({ skipAudit: true })
    return
  }
  // First click: run the audit pre-flight. If it surfaces error-severity
  // issues (or strict-promoted warns), we hold the user in the audit-
  // review state. Warn-only issues from a non-strict target are
  // informational — the design ships warns as background-scanner
  // concerns, not publish-time gates — so we auto-proceed to keep the
  // common-case publish flow one click. The server-side gate at
  // /api/publish still re-runs the audit and 409s on remaining errors,
  // so a stale audit response can't slip past.
  const dests = [...selectedDestinations.value]
  const items = [...selectedItems.value]
  auditing.value = true
  try {
    const state = await runPrePublishAudit(items, dests)
    const hasBlockingIssues = state.some(t => t.issues.some(i => i.severity === 'error'))
    if (hasBlockingIssues) {
      auditState.value = state
      return
    }
  } finally {
    auditing.value = false
  }
  await runPublish({ skipAudit: true })
}

async function runPublish(opts: { skipAudit?: boolean } = {}) {
  const src = sourceName.value
  if (!src) return
  const dests = [...selectedDestinations.value]
  const items = [...selectedItems.value]
  confirming.value = false
  publishing.value = true
  results.value = null
  publishError.value = null
  invalidTemplates.value = []
  progress.value = new Map(dests.map(d => [d, { current: 0, total: 0, label: 'pending…', status: 'pending' as const }]))
  // skipAudit lets the caller bypass — used after the audit modal already
  // ran. The server-side gate at POST /api/publish remains; if a
  // PUBLISH_AUDIT_FAILED 409 lands we surface the same audit-review UX.
  void opts.skipAudit
  try {
    const finalResults = await publishApi.publishStream(
      items,
      dests,
      ev => {
        if (ev.kind === 'target-start') {
          const m = new Map(progress.value)
          m.set(ev.target, { current: 0, total: ev.total, label: 'starting…', status: 'in-progress' })
          progress.value = m
        } else if (ev.kind === 'progress') {
          const m = new Map(progress.value)
          const existing = m.get(ev.target) ?? {
            current: 0,
            total: ev.total,
            label: '',
            status: 'in-progress' as const,
          }
          m.set(ev.target, { ...existing, current: ev.current, total: ev.total, label: ev.label })
          progress.value = m
        } else if (ev.kind === 'target-result') {
          const m = new Map(progress.value)
          const existing = m.get(ev.result.target)
          if (existing) {
            m.set(ev.result.target, {
              ...existing,
              status: ev.result.success ? 'done' : 'error',
              label: ev.result.success ? `done · ${ev.result.copiedFiles} files` : (ev.result.error ?? 'failed'),
            })
          }
          progress.value = m
        }
      },
      { source: src },
    )
    results.value = finalResults
    // Any target that was published is now potentially in a new state —
    // refresh its sync status so chips / item list reflect it.
    for (const d of dests) syncStatus.invalidate(d)
    syncStatus.refreshAll()
  } catch (err) {
    if (err instanceof PublishAuditFailedError) {
      // Server-side gate caught what the client-side dialog didn't —
      // either a race (validators changed mid-flight) or a determined
      // client. Surface the same audit-review UX so the author sees
      // the issues and can fix or abort.
      auditState.value = err.blocked.map(b => ({ target: b.target, strict: false, issues: b.issues }))
      // Re-evaluate ignoredWarns against the new issue set — server
      // 409s only on errors, so any prior warn-ignore is irrelevant
      // but harmless to keep around.
    } else {
      const e = err as Error & { invalidTemplates?: { name: string; errors: string[] }[] }
      publishError.value = e.message
      if (e.invalidTemplates) invalidTemplates.value = e.invalidTemplates
    }
  } finally {
    publishing.value = false
  }
}

// --- Panel lifecycle --------------------------------------------------

watch(
  () => props.visible,
  v => {
    if (!v) {
      // Clear selection on close so stale state doesn't leak between
      // invocations (e.g., different source next time).
      selectedItems.value = new Set()
      resetPublishState()
      return
    }
    resetPublishState()
    sourceName.value = pickDefaultSource()
    const preselect = new Set<string>()
    if (props.initialDestination && destinationOptions.value.some(t => t.name === props.initialDestination)) {
      preselect.add(props.initialDestination)
    }
    selectedDestinations.value = preselect
    selectedItems.value = new Set()
    // Kick off sync-status refresh so the destination list shows accurate
    // change counts. syncStatus caches per-target; this is cheap on reopen.
    if (activeTarget.targets.length > 1) syncStatus.refreshAll()
  },
)

// When the source changes, any previously-selected destinations that
// happen to now BE the source get dropped automatically.
watch(sourceName, name => {
  if (!name) return
  if (selectedDestinations.value.has(name)) {
    const next = new Set(selectedDestinations.value)
    next.delete(name)
    selectedDestinations.value = next
  }
})

// Any change to destinations or items invalidates a pending confirmation —
// otherwise the user could flip selections after clicking once and push
// somewhere they didn't review.
watch([selectedDestinations, selectedItems], () => {
  confirming.value = false
})

function close() {
  emit('update:visible', false)
}

// --- Action (stubbed in R38a; wired in R38c) -------------------------

const canPublish = computed(
  () => !!sourceName.value && selectedDestinations.value.size > 0 && selectedItems.value.size > 0,
)

const publishLabel = computed(() => {
  if (auditing.value) return 'Running audit…'
  if (auditState.value) {
    if (blockingIssueTotal.value > 0) {
      return `Fix ${blockingIssueTotal.value} ${blockingIssueTotal.value === 1 ? 'issue' : 'issues'} to publish`
    }
    return 'Continue to publish'
  }
  const items = selectedItems.value.size
  const dests = selectedDestinations.value.size
  if (items === 0 || dests === 0) return 'Publish'
  return `Publish ${items} ${items === 1 ? 'item' : 'items'} → ${dests} ${dests === 1 ? 'target' : 'targets'}`
})

const publishTitle = computed(() => {
  if (auditState.value && blockingIssueTotal.value > 0) {
    return 'Resolve all errors to publish'
  }
  if (!sourceName.value) return 'Pick a source'
  if (selectedDestinations.value.size === 0) return 'Pick at least one destination'
  if (selectedItems.value.size === 0) return 'Pick at least one item'
  return ''
})

function statusLabel(name: string): string {
  if (syncStatus.isLoading(name)) return '…'
  const err = syncStatus.errorFor(name)
  if (err) return '?'
  const s = syncStatus.get(name)
  if (!s) return ''
  if (s.firstPublish) return 'not yet published'
  if (s.changedCount === 0) return 'in sync'
  return `${s.changedCount} behind`
}

function envClass(env: string | undefined): string {
  if (env === 'production') return 'env-production'
  if (env === 'staging') return 'env-staging'
  return 'env-local'
}
</script>

<template>
  <Dialog :visible="props.visible" @update:visible="v => emit('update:visible', v)"
    modal dismissableMask :closable="true" header="Publish"
    :style="{ width: '760px', maxWidth: '95vw' }"
    data-testid="publish-panel">
    <div class="publish-panel">
      <!-- Source picker -->
      <div class="row">
        <label class="row-label">From</label>
        <Select
          v-if="editableTargets.length > 1"
          :modelValue="sourceName"
          @update:modelValue="(v: string) => sourceName = v"
          :options="editableTargets"
          optionLabel="name"
          optionValue="name"
          placeholder="Select source"
          data-testid="publish-source-select"
          class="row-control"
        />
        <div v-else class="row-value" data-testid="publish-source-fixed">
          <span :class="['chip', envClass(editableTargets[0]?.environment)]">
            {{ sourceName ?? '(no editable target)' }}
          </span>
        </div>
      </div>

      <!-- Destinations -->
      <div class="row">
        <label class="row-label">To</label>
        <div v-if="destinationOptions.length === 0" class="row-value muted">
          (no other targets configured)
        </div>
        <div v-else class="destinations" data-testid="publish-destinations">
          <template v-for="entry in destinationEntries" :key="entry.kind === 'single' ? entry.target.name : entry.group.environment">
            <!-- Flat single destination (≤3 targets, OR 1-member groups
                 at 4+). No header. -->
            <label
              v-if="entry.kind === 'single'"
              :class="['destination', envClass(entry.target.environment)]"
              :data-testid="`publish-dest-${entry.target.name}`">
              <Checkbox
                :modelValue="selectedDestinations.has(entry.target.name)"
                @update:modelValue="() => toggleDestination(entry.target.name)"
                :inputId="`dest-${entry.target.name}`"
                :binary="true"
              />
              <span class="dest-name">{{ entry.target.name }}</span>
              <span v-if="!entry.target.editable" class="dest-badge">read-only</span>
              <span class="dest-status">{{ statusLabel(entry.target.name) }}</span>
            </label>
            <!-- Group header + indented members (4+ targets, 2+ in env) -->
            <template v-else>
              <label
                :class="['destination-group-header', envClass(entry.group.environment)]"
                :data-testid="`publish-dest-group-${entry.group.environment}`"
                :for="`dest-group-${entry.group.environment}`">
                <Checkbox
                  :modelValue="groupState(entry.group) === 'all'"
                  :indeterminate="groupState(entry.group) === 'some'"
                  :inputId="`dest-group-${entry.group.environment}`"
                  :binary="true"
                  @update:modelValue="() => toggleGroup(entry.group)"
                />
                <span class="group-label">{{ entry.group.environment }}</span>
                <span class="group-count">{{ entry.group.members.length }} targets</span>
              </label>
              <label
                v-for="t in entry.group.members"
                :key="t.name"
                :class="['destination', envClass(t.environment), 'grouped']"
                :data-testid="`publish-dest-${t.name}`">
                <Checkbox
                  :modelValue="selectedDestinations.has(t.name)"
                  @update:modelValue="() => toggleDestination(t.name)"
                  :inputId="`dest-${t.name}`"
                  :binary="true"
                />
                <span class="dest-name">{{ t.name }}</span>
                <span v-if="!t.editable" class="dest-badge">read-only</span>
                <span class="dest-status">{{ statusLabel(t.name) }}</span>
              </label>
            </template>
          </template>
        </div>
      </div>

      <!-- Items -->
      <div class="row row-items">
        <label class="row-label">Items</label>
        <PublishItemList
          :source="sourceName"
          :destinations="destinationNames"
          :selected="selectedItems"
          @update:selected="(v: Set<string>) => selectedItems = v"
        />
      </div>

      <!-- Confirmation banner for production destinations -->
      <div v-if="confirming" class="publish-confirm-banner" data-testid="publish-confirm-banner">
        <i class="pi pi-exclamation-triangle" />
        <span>
          This will publish to
          <strong>{{ productionDestinations.map(t => t.name).join(', ') }}</strong>
          — live content will change.
        </span>
      </div>

      <!-- Pre-publish audit results (Validation Cut 4) -->
      <div v-if="auditState && auditHasIssues" class="publish-audit" data-testid="publish-audit">
        <div class="publish-audit-header">
          <i class="pi pi-shield" />
          <span>
            <strong>Pre-publish audit:</strong>
            {{ blockingIssueTotal === 0
              ? 'all errors resolved — ready to publish.'
              : `${blockingIssueTotal} ${blockingIssueTotal === 1 ? 'issue blocks' : 'issues block'} this publish.` }}
          </span>
        </div>
        <div v-for="perTarget in auditState" :key="perTarget.target" class="publish-audit-target"
          :data-testid="`publish-audit-target-${perTarget.target}`">
          <div class="publish-audit-target-header">
            <span class="audit-target-name">{{ perTarget.target }}</span>
            <span v-if="perTarget.strict" class="audit-strict-badge">strict</span>
            <span class="audit-target-count">
              {{ perTarget.issues.length }}
              {{ perTarget.issues.length === 1 ? 'issue' : 'issues' }}
            </span>
          </div>
          <ul class="publish-audit-issues">
            <li v-for="issue in perTarget.issues" :key="auditIssueKey(perTarget.target, issue)"
              :class="['publish-audit-issue', `severity-${issue.severity}`,
                       issue.severity === 'warn' && isWarnIgnored(perTarget.target, issue) ? 'ignored' : '']"
              :data-testid="`publish-audit-issue-${perTarget.target}-${issue.validator}`">
              <span class="audit-severity">{{ issue.severity }}</span>
              <span class="audit-validator">{{ issue.validator }}</span>
              <span class="audit-message">{{ issue.message }}</span>
              <span class="audit-itempath">{{ issue.itemPath }}</span>
              <label v-if="issue.severity === 'warn'" class="audit-ignore">
                <Checkbox
                  :modelValue="isWarnIgnored(perTarget.target, issue)"
                  :binary="true"
                  @update:modelValue="() => toggleIgnoreWarn(perTarget.target, issue)"
                  :inputId="`ignore-${auditIssueKey(perTarget.target, issue)}`"
                  :data-testid="`publish-audit-ignore-${perTarget.target}-${issue.validator}`"
                />
                <span>Ignore once</span>
              </label>
            </li>
          </ul>
        </div>
      </div>

      <!-- Invalid templates (fatal) -->
      <div v-if="invalidTemplates.length > 0" class="publish-error" data-testid="publish-invalid-templates">
        <i class="pi pi-exclamation-triangle" />
        <div class="publish-error-body">
          <p><strong>{{ invalidTemplates.length }} template{{ invalidTemplates.length === 1 ? '' : 's' }} can't be rendered.</strong></p>
          <ul class="publish-invalid-list">
            <li v-for="tpl in invalidTemplates" :key="tpl.name">
              <span class="publish-invalid-name">{{ tpl.name }}</span>
              <span class="publish-invalid-error">{{ tpl.errors[0] }}</span>
            </li>
          </ul>
        </div>
      </div>

      <!-- Generic fatal error -->
      <div v-else-if="publishError" class="publish-error" data-testid="publish-error">
        <i class="pi pi-exclamation-circle" />
        <span>{{ publishError }}</span>
      </div>

      <!-- Progress: streaming per-destination -->
      <div v-if="publishing && progress.size > 0" class="publish-progress" data-testid="publish-progress">
        <div v-for="[destName, p] in progress" :key="destName" class="progress-row">
          <div class="progress-header">
            <span class="progress-target">{{ destName }}</span>
            <span class="progress-count">{{ p.current }} / {{ p.total }}</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill"
              :style="{ width: (p.total ? Math.round(100 * p.current / p.total) : 0) + '%' }" />
          </div>
          <div class="progress-label" :title="p.label">{{ p.label }}</div>
        </div>
      </div>

      <!-- Results -->
      <div v-if="results" class="publish-results" data-testid="publish-results">
        <div v-for="r in results" :key="r.target" class="publish-result"
          :class="{ success: r.success, error: !r.success }"
          :data-testid="`publish-result-${r.target}`">
          <i :class="r.success ? 'pi pi-check-circle' : 'pi pi-exclamation-circle'" />
          <span class="result-target">{{ r.target }}</span>
          <span v-if="r.success" class="result-detail">{{ r.copiedFiles }} files</span>
          <span v-else class="result-detail">{{ r.error }}</span>
          <!-- Undo affordance — rolls the destination back to the pre-
               publish state. Only shown on success; disabled once
               undone so a rapid double-click doesn't double-rollback. -->
          <button
            v-if="r.success"
            type="button"
            class="result-undo"
            :disabled="undoneTargets.has(r.target)"
            :data-testid="`publish-result-undo-${r.target}`"
            @click="undoPublish(r.target)">
            {{ undoneTargets.has(r.target) ? 'Undone' : 'Undo' }}
          </button>
        </div>
      </div>
    </div>

    <template #footer>
      <template v-if="results">
        <Button label="Done" data-testid="publish-panel-done" @click="close" />
      </template>
      <template v-else>
        <Button
          :label="confirming ? 'Back' : 'Cancel'"
          severity="secondary"
          @click="confirming ? (confirming = false) : close()"
          data-testid="publish-panel-cancel" />
        <Button v-if="!confirming"
          :label="publishLabel"
          :icon="publishing || auditing ? undefined : 'pi pi-cloud-upload'"
          severity="success"
          :loading="publishing || auditing"
          :disabled="!canPublish || publishing || auditing || (auditState ? blockingIssueTotal > 0 : false)"
          :title="publishTitle"
          data-testid="publish-panel-confirm"
          @click="handlePublishClick"
        />
        <Button v-else
          :label="`Yes, publish to ${productionDestinations.map(t => t.name).join(', ')}`"
          icon="pi pi-exclamation-triangle"
          severity="danger"
          :loading="publishing"
          data-testid="publish-panel-confirm-prod"
          @click="() => runPublish()"
        />
      </template>
    </template>
  </Dialog>
</template>

<style scoped>
.publish-panel {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  padding-top: 0.5rem;
}
.row {
  display: flex;
  align-items: flex-start;
  gap: 1rem;
}
.row-items {
  flex-direction: column;
  align-items: stretch;
  gap: 0.5rem;
}
.row-items .row-label {
  padding-top: 0;
}
.row-label {
  flex: 0 0 5rem;
  padding-top: 0.375rem;
  color: var(--color-muted);
  font-size: 0.8125rem;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.row-control {
  flex: 1;
  min-width: 0;
}
.row-value {
  flex: 1;
  min-width: 0;
  padding-top: 0.375rem;
}
.row-value.muted {
  color: var(--color-muted);
  font-size: 0.8125rem;
  font-style: italic;
}

.chip {
  display: inline-flex;
  align-items: center;
  padding: 0.25rem 0.625rem;
  border-radius: var(--p-border-radius-sm);
  font-size: 0.8125rem;
  font-weight: 500;
  background: var(--color-hover-bg);
  border: 1px solid var(--color-border);
}
.chip.env-production {
  background: var(--color-env-prod-bg);
  color: var(--color-env-prod-fg);
  border-color: var(--color-env-prod-fg);
}
.chip.env-staging {
  background: var(--color-env-staging-bg);
  color: var(--color-env-staging-fg);
  border-color: var(--color-env-staging-fg);
}

.destinations {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}
.destination {
  display: grid;
  grid-template-columns: auto 1fr auto auto;
  align-items: center;
  gap: 0.625rem;
  padding: 0.5rem 0.75rem;
  border-radius: var(--p-border-radius-sm);
  border: 1px solid var(--color-border);
  cursor: pointer;
  font-size: 0.875rem;
}
.destination:hover {
  background: var(--color-hover-bg);
}
.dest-name {
  font-weight: 500;
}
.dest-badge {
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.65;
  padding: 0.125rem 0.375rem;
  border: 1px solid currentColor;
  border-radius: var(--p-border-radius-xs);
}
.dest-status {
  font-size: 0.75rem;
  color: var(--color-muted);
  font-variant-numeric: tabular-nums;
}

.destination.env-production {
  border-left: 3px solid var(--color-env-prod-fg);
}
.destination.env-staging {
  border-left: 3px solid var(--color-env-staging-fg);
}
/* Members of a multi-target group — inset slightly and drop the colored
   left border so the group header carries the environment chrome. */
.destination.grouped {
  margin-left: 1.25rem;
  border-left: 1px solid var(--color-border);
}

.destination-group-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.625rem;
  border-radius: var(--p-border-radius-sm);
  font-size: 0.8125rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  border: 1px solid var(--color-border);
  margin-bottom: 0.125rem;
  background: transparent;
  cursor: pointer;
  font-family: inherit;
  color: inherit;
  text-align: left;
  width: 100%;
}
.destination-group-header:hover { opacity: 0.9; }
.destination-group-header.env-production {
  background: var(--color-env-prod-bg);
  color: var(--color-env-prod-fg);
  border-color: var(--color-env-prod-fg);
}
.destination-group-header.env-staging {
  background: var(--color-env-staging-bg);
  color: var(--color-env-staging-fg);
  border-color: var(--color-env-staging-fg);
}
.group-label { flex: 1; }
.group-count {
  font-size: 0.6875rem;
  font-weight: 500;
  letter-spacing: 0;
  text-transform: none;
  opacity: 0.75;
}

.publish-confirm-banner {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border-radius: var(--p-border-radius-md);
  background: var(--color-danger-bg);
  color: var(--color-danger-fg);
  font-size: 0.875rem;
}
.publish-error {
  display: flex;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border-radius: var(--p-border-radius-md);
  background: var(--color-danger-bg);
  color: var(--color-danger-fg);
  font-size: 0.875rem;
}
.publish-error-body { display: flex; flex-direction: column; gap: 0.375rem; flex: 1; }
.publish-error-body p { margin: 0; }
.publish-invalid-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.25rem; }
.publish-invalid-list li { display: flex; flex-direction: column; gap: 0.125rem; font-size: 0.8125rem; }
.publish-invalid-name { font-family: ui-monospace, monospace; font-weight: 600; }
.publish-invalid-error { opacity: 0.85; font-size: 0.75rem; }

.publish-audit {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.75rem;
  border-radius: var(--p-border-radius-md);
  background: var(--color-warning-bg);
  color: var(--color-warning-fg);
  font-size: 0.875rem;
}
.publish-audit-header { display: flex; align-items: center; gap: 0.5rem; }
.publish-audit-target { display: flex; flex-direction: column; gap: 0.375rem; }
.publish-audit-target-header { display: flex; align-items: baseline; gap: 0.5rem; font-size: 0.8125rem; }
.audit-target-name { font-weight: 600; }
.audit-strict-badge {
  font-size: 0.6875rem;
  text-transform: uppercase;
  padding: 0.0625rem 0.375rem;
  border-radius: var(--p-border-radius-sm);
  background: var(--color-danger-bg);
  color: var(--color-danger-fg);
}
.audit-target-count { color: var(--color-muted); font-size: 0.75rem; }
.publish-audit-issues { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.25rem; }
.publish-audit-issue {
  display: grid;
  grid-template-columns: minmax(3rem, auto) auto 1fr auto auto;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.5rem;
  border-radius: var(--p-border-radius-sm);
  background: var(--color-bg);
  font-size: 0.8125rem;
}
.publish-audit-issue.severity-error { border-left: 3px solid var(--color-danger-fg); }
.publish-audit-issue.severity-warn { border-left: 3px solid var(--color-warning-fg); }
.publish-audit-issue.severity-info { border-left: 3px solid var(--color-info-fg); }
.publish-audit-issue.ignored { opacity: 0.55; }
.audit-severity {
  text-transform: uppercase;
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.04em;
}
.audit-validator { font-family: ui-monospace, monospace; font-size: 0.75rem; color: var(--color-muted); }
.audit-message { color: var(--color-fg); }
.audit-itempath { font-family: ui-monospace, monospace; font-size: 0.75rem; color: var(--color-muted); }
.audit-ignore { display: flex; align-items: center; gap: 0.375rem; cursor: pointer; font-size: 0.75rem; }

.publish-progress { display: flex; flex-direction: column; gap: 0.75rem; }
.progress-row { display: flex; flex-direction: column; gap: 0.25rem; }
.progress-header { display: flex; justify-content: space-between; align-items: baseline; font-size: 0.8125rem; }
.progress-target { font-weight: 600; }
.progress-count { color: var(--color-muted); font-variant-numeric: tabular-nums; font-size: 0.75rem; }
.progress-bar { height: 4px; background: var(--color-hover-bg); border-radius: 2px; overflow: hidden; }
.progress-fill { height: 100%; background: var(--p-primary-color); transition: width 200ms ease; }
.progress-label { font-size: 0.75rem; color: var(--color-muted); font-family: ui-monospace, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.publish-results { display: flex; flex-direction: column; gap: 0.5rem; }
.publish-result { display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem; border-radius: var(--p-border-radius-md); }
.publish-result.success { background: var(--color-success-bg); color: var(--color-success-fg); }
.publish-result.error { background: var(--color-danger-bg); color: var(--color-danger-fg); }
.result-target { font-weight: 600; }
.result-detail { margin-left: auto; font-size: 0.875rem; opacity: 0.8; }
.result-undo {
  background: transparent;
  border: 1px solid currentColor;
  color: inherit;
  padding: 0.125rem 0.5rem;
  border-radius: var(--p-border-radius-sm);
  font: inherit;
  font-size: 0.75rem;
  cursor: pointer;
  opacity: 0.85;
}
.result-undo:hover:not(:disabled) { opacity: 1; }
.result-undo:disabled { cursor: default; opacity: 0.5; }
</style>
