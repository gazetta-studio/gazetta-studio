<script setup lang="ts">
/**
 * Compact sync status chips for non-active targets.
 *
 * One chip per non-active target, showing "name · N behind" or "name · in sync".
 * At 4+ total targets, members of the same `environment` collapse into a
 * single group chip (e.g. "production (2) · 7 behind") that expands
 * inline on click — design-editor-ux.md "Scaling to 4+ targets".
 *
 * Environment chrome matches the ActiveTargetIndicator so the top bar reads
 * as a single row of related pills.
 *
 * Progressive disclosure: hidden entirely when there are no non-active
 * targets to report on.
 */
import { ChevronDown, ChevronRight } from '@lucide/vue'
import { computed, ref } from 'vue'
import { useSyncStatusStore } from '../stores/syncStatus.js'
import { useActiveTargetStore } from '../stores/activeTarget.js'
import { groupedEntries, type TargetGroup } from '../composables/targetGrouping.js'
import type { TargetInfo } from '../api/client.js'

const sync = useSyncStatusStore()
const activeTarget = useActiveTargetStore()

const emit = defineEmits<{ (e: 'select', name: string): void }>()

function environmentClass(env: string | undefined): string {
  if (env === 'production') return 'env-production'
  if (env === 'staging') return 'env-staging'
  return 'env-local'
}

function statusLabel(t: TargetInfo): string {
  if (sync.isLoading(t.name)) return '…'
  const err = sync.errorFor(t.name)
  if (err) return '?'
  const status = sync.get(t.name)
  if (!status) return '—'
  if (status.firstPublish) return 'not yet published'
  if (status.changedCount === 0) return 'in sync'
  return `${status.changedCount} behind`
}

function statusClass(t: TargetInfo): string {
  if (sync.isLoading(t.name)) return 'state-loading'
  if (sync.errorFor(t.name)) return 'state-error'
  const status = sync.get(t.name)
  if (!status) return 'state-unknown'
  if (status.firstPublish) return 'state-unpublished'
  if (status.changedCount === 0) return 'state-synced'
  return 'state-behind'
}

/**
 * Aggregate label for a collapsed group — "N behind" sums members,
 * treating unpublished (firstPublish) members as their full item count.
 * When every member is in sync, shows "in sync". When any member is
 * still loading, shows "…".
 */
function groupStatusLabel(group: TargetGroup): string {
  if (group.members.some(m => sync.isLoading(m.name))) return '…'
  const statuses = group.members.map(m => sync.get(m.name))
  if (statuses.some(s => !s)) return '—'
  const total = statuses.reduce((n, s) => n + (s?.changedCount ?? 0), 0)
  const anyUnpublished = statuses.some(s => s?.firstPublish)
  if (total === 0 && !anyUnpublished) return 'in sync'
  if (total === 0 && anyUnpublished) return 'not yet published'
  return `${total} behind`
}

/**
 * Worst-case state class for a group — drives border color and emphasis.
 * "behind" beats "unpublished" beats "synced" so the chip visually
 * surfaces anything that needs attention.
 */
function groupStatusClass(group: TargetGroup): string {
  if (group.members.some(m => sync.isLoading(m.name))) return 'state-loading'
  if (group.members.some(m => sync.errorFor(m.name))) return 'state-error'
  const statuses = group.members.map(m => sync.get(m.name))
  const totalChanged = statuses.reduce((n, s) => n + (s?.changedCount ?? 0), 0)
  if (totalChanged > 0) return 'state-behind'
  if (statuses.some(s => s?.firstPublish)) return 'state-unpublished'
  return 'state-synced'
}

// Render shape: flat singles when the fleet is small, grouped when 4+.
// Passes the TOTAL target count (not just non-active) so sync chips
// match the rest of the UI's grouping decision.
const entries = computed(() => groupedEntries(sync.nonActiveTargets, activeTarget.targets.length))

const expandedGroups = ref(new Set<string>())
function toggleGroup(env: string) {
  const next = new Set(expandedGroups.value)
  if (next.has(env)) next.delete(env)
  else next.add(env)
  expandedGroups.value = next
}

const hasAnything = computed(() => entries.value.length > 0)
</script>

<template>
  <div v-if="hasAnything" class="sync-indicators" data-testid="sync-indicators">
    <template v-for="entry in entries" :key="entry.kind === 'single' ? entry.target.name : entry.group.environment">
      <!-- Flat single target chip (≤3 targets, OR 1-member groups in 4+) -->
      <button
        v-if="entry.kind === 'single'"
        type="button"
        class="sync-chip"
        :class="[environmentClass(entry.target.environment), statusClass(entry.target)]"
        :data-testid="`sync-chip-${entry.target.name}`"
        :title="`${entry.target.name}: ${statusLabel(entry.target)} — click to see changes`"
        @click="emit('select', entry.target.name)">
        <span class="dot" aria-hidden="true" />
        <span class="name">{{ entry.target.name }}</span>
        <span class="sep" aria-hidden="true">·</span>
        <span class="status">{{ statusLabel(entry.target) }}</span>
      </button>

      <!-- Group chip (4+ total, 2+ members in this env). Click expands
           inline to show per-member chips underneath. -->
      <template v-else>
        <button
          type="button"
          class="sync-chip sync-chip-group"
          :class="[environmentClass(entry.group.environment), groupStatusClass(entry.group), { expanded: expandedGroups.has(entry.group.environment) }]"
          :data-testid="`sync-chip-group-${entry.group.environment}`"
          :title="`${entry.group.environment}: ${entry.group.members.length} targets — click to expand`"
          :aria-expanded="expandedGroups.has(entry.group.environment)"
          @click="toggleGroup(entry.group.environment)">
          <span class="dot" aria-hidden="true" />
          <span class="name">{{ entry.group.environment }}</span>
          <span class="group-count">({{ entry.group.members.length }})</span>
          <span class="sep" aria-hidden="true">·</span>
          <span class="status">{{ groupStatusLabel(entry.group) }}</span>
          <component :is="expandedGroups.has(entry.group.environment) ? ChevronDown : ChevronRight" class="chevron" aria-hidden="true" />
        </button>
        <!-- Expanded member chips. Rendered inline so they share the
             top-bar row; parent handles overflow. -->
        <template v-if="expandedGroups.has(entry.group.environment)">
          <button
            v-for="m in entry.group.members"
            :key="m.name"
            type="button"
            class="sync-chip sync-chip-member"
            :class="[environmentClass(m.environment), statusClass(m)]"
            :data-testid="`sync-chip-${m.name}`"
            :title="`${m.name}: ${statusLabel(m)} — click to see changes`"
            @click="emit('select', m.name)">
            <span class="dot" aria-hidden="true" />
            <span class="name">{{ m.name }}</span>
            <span class="sep" aria-hidden="true">·</span>
            <span class="status">{{ statusLabel(m) }}</span>
          </button>
        </template>
      </template>
    </template>
  </div>
</template>

<style scoped>
.sync-indicators {
  display: inline-flex;
  gap: 0.25rem;
  align-items: center;
  margin-left: 0.5rem;
}
.sync-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.125rem 0.5rem;
  border-radius: var(--radius-sm);
  font-size: 0.75rem;
  color: var(--color-muted);
  border: 1px solid var(--color-border);
  background: transparent;
  letter-spacing: -0.01em;
  cursor: pointer;
  font-family: inherit;
}
.sync-chip:hover {
  background: var(--color-hover-bg);
}
.sync-chip:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}
.chevron {
  inline-size: 1em;
  block-size: 1em;
  flex: none;
}
.dot {
  width: 0.375rem;
  height: 0.375rem;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.55;
}
.name {
  font-weight: 500;
}
.sep {
  opacity: 0.4;
}
.status {
  opacity: 0.85;
}

/* State modifiers — give the status word a hint of its own color so the
   scanning author can spot "behind" without reading. */
.sync-chip.state-synced { color: var(--color-success-fg); }
.sync-chip.state-behind { color: var(--color-fg); border-color: var(--color-fg); opacity: 0.9; }
.sync-chip.state-unpublished { color: var(--color-muted); }
.sync-chip.state-error { color: var(--color-danger-fg); }
/* No chip-wide opacity for loading — even at 0.7 it dragged
   `--color-muted` (the chip's text color) below the 4.5:1 contrast
   floor against the dark content background. The "…" character in
   the status field is enough to convey "in progress" without dimming
   the env name and count alongside it. */
.sync-chip.state-loading .status { font-style: italic; }

/* Environment tints — only on the border/dot to stay compact. The active
   target (in ActiveTargetIndicator) gets the full color fill. */
.sync-chip.env-production { border-color: var(--color-env-prod-fg); }
.sync-chip.env-production .dot { color: var(--color-env-prod-fg); }
.sync-chip.env-staging { border-color: var(--color-env-staging-fg); }
.sync-chip.env-staging .dot { color: var(--color-env-staging-fg); }

/* Group chip — slightly heavier than individual chips, chevron on the end. */
.sync-chip-group {
  font-weight: 500;
}
.sync-chip-group .pi {
  font-size: 0.625rem;
  opacity: 0.7;
  margin-left: 0.125rem;
}
.sync-chip-group .group-count {
  font-weight: 400;
  /* No opacity on the count — it compounded with the chip's muted text
     color and pushed contrast below 4.5:1. The lighter font-weight is
     enough visual hierarchy. */
  margin-left: -0.125rem;
}
.sync-chip-group.expanded {
  background: var(--color-hover-bg);
}

/* Member chip — inset under the group header. The `↳` prefix on the
   name carries the "child of group" signal; chip-wide opacity would
   push contrast under the WCAG floor. */
.sync-chip-member {
  padding-left: 0.625rem;
}
.sync-chip-member .name::before {
  content: '↳ ';
  opacity: 0.5;
  font-weight: 400;
}
</style>
