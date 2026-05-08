<script setup lang="ts">
/**
 * Template impact panel (Validation Cut 6).
 *
 * Storybook-style "what does this template touch?" view inside the
 * DevPlayground's right detail pane. Lists every page + fragment that
 * uses the selected template — top-level OR nested inline — with
 * per-item severity icons (✓ clean, ⚠ warns, ✗ errors). Click an
 * affected item to navigate to its editor; the existing
 * site-health drawer + ValidationBanner take over field-focus from
 * there.
 *
 * "Migrate" affordance is reserved for a future AI-task surface (per
 * `design-ai.md` extension model — schema migrations are too feature-
 * specific to automate generically; the AI seam is the right home
 * when concrete demand surfaces). For now the row's primary action
 * is "Edit".
 *
 * # SOLID lenses
 *
 *   - SRP: this component renders one tab on one selected template.
 *     Walking the site → API; subscribing to scanner state → store.
 *   - DIP: depends on `TemplatesApi.getTemplateImpact` + the scanner
 *     store's `byItem` lookup. No coupling to the SSE channel.
 */
import { ref, computed, watch, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useTemplatesApi } from '../composables/api.js'
import { useValidationScannerStore } from '../stores/validationScanner.js'
import type { TemplateImpactItem, TemplateImpactResponse, ValidationIssue } from '../api/client.js'

const props = defineProps<{
  /** Template name. The panel re-fetches when this changes. */
  template: string
}>()

const templatesApi = useTemplatesApi()
const scanner = useValidationScannerStore()
const router = useRouter()

const data = ref<TemplateImpactResponse | null>(null)
const loading = ref(false)
const errorMessage = ref<string | null>(null)

async function load(name: string) {
  loading.value = true
  errorMessage.value = null
  try {
    data.value = await templatesApi.getTemplateImpact(name)
  } catch (err) {
    errorMessage.value = (err as Error).message
    data.value = null
  } finally {
    loading.value = false
  }
}

onMounted(() => load(props.template))
watch(
  () => props.template,
  name => {
    void load(name)
  },
)
// Re-fetch on every scanner update — the scanner tells us when issues
// changed for any item, including the ones using this template.
// Tracking byItem keeps the panel current without manual refresh.
watch(
  () => scanner.lastFetchedAt,
  () => {
    if (props.template) void load(props.template)
  },
)

interface DisplayRow {
  item: TemplateImpactItem
  worst: 'error' | 'warn' | 'info' | null
}

/**
 * Worst severity for a row drives the icon; null means clean (✓).
 * Local helper because the scanner store's `severityFor` returns the
 * same shape but only for items the scanner has scanned — items that
 * use the template but aren't tracked yet still need a value.
 */
function worstSeverity(issues: readonly ValidationIssue[]): 'error' | 'warn' | 'info' | null {
  if (!issues.length) return null
  if (issues.some(i => i.severity === 'error')) return 'error'
  if (issues.some(i => i.severity === 'warn')) return 'warn'
  return 'info'
}

const rows = computed<DisplayRow[]>(() => {
  if (!data.value) return []
  return data.value.items.map(item => ({ item, worst: worstSeverity(item.issues) }))
})

function severityIconClass(worst: DisplayRow['worst']): string {
  if (worst === 'error') return 'pi pi-times-circle severity-error'
  if (worst === 'warn') return 'pi pi-exclamation-triangle severity-warn'
  if (worst === 'info') return 'pi pi-info-circle severity-info'
  return 'pi pi-check-circle severity-clean'
}

function severityLabel(worst: DisplayRow['worst']): string {
  if (worst === 'error') return 'Errors'
  if (worst === 'warn') return 'Warnings'
  if (worst === 'info') return 'Info'
  return 'Clean'
}

function navigateToItem(item: TemplateImpactItem) {
  if (item.kind === 'page') {
    router.push({ path: `/pages/${item.name}` })
  } else {
    router.push({ path: `/fragments/${item.name}` })
  }
}
</script>

<template>
  <div class="template-impact" data-testid="template-impact-panel">
    <div v-if="loading" class="impact-empty" data-testid="template-impact-loading">
      <i class="pi pi-spin pi-spinner" />
      <span>Loading impact…</span>
    </div>
    <div v-else-if="errorMessage" class="impact-error" data-testid="template-impact-error">
      <i class="pi pi-exclamation-circle" />
      <span>{{ errorMessage }}</span>
    </div>
    <div v-else-if="!data || data.items.length === 0" class="impact-empty" data-testid="template-impact-empty">
      <i class="pi pi-info-circle" />
      <span>No items use this template.</span>
    </div>
    <template v-else>
      <div class="impact-summary" data-testid="template-impact-summary">
        <strong>{{ data.items.length }}</strong>
        {{ data.items.length === 1 ? 'item uses' : 'items use' }} <code>{{ data.template }}</code>
        <span v-if="data.affectedItemCount > 0" class="summary-affected">
          —
          <strong>{{ data.affectedItemCount }}</strong>
          with issues
        </span>
        <span v-else class="summary-clean">— all clean</span>
      </div>
      <ul class="impact-rows">
        <li
          v-for="row in rows"
          :key="row.item.itemPath"
          :class="['impact-row', `severity-${row.worst ?? 'clean'}`]"
          :data-testid="`template-impact-row-${row.item.kind}-${row.item.name}`">
          <i :class="severityIconClass(row.worst)" :title="severityLabel(row.worst)" />
          <div class="row-body">
            <div class="row-head">
              <span class="row-kind">{{ row.item.kind === 'page' ? 'Page' : 'Fragment' }}</span>
              <span class="row-name">{{ row.item.name }}</span>
              <span v-if="row.item.issues.length > 0" class="row-issue-count">
                {{ row.item.issues.length }} {{ row.item.issues.length === 1 ? 'issue' : 'issues' }}
              </span>
            </div>
            <ul v-if="row.item.issues.length > 0" class="row-issues">
              <li v-for="(issue, idx) in row.item.issues" :key="idx" class="row-issue">
                <span class="issue-severity">{{ issue.severity }}</span>
                <span class="issue-validator">{{ issue.validator }}</span>
                <span class="issue-message">{{ issue.message }}</span>
              </li>
            </ul>
          </div>
          <button
            type="button"
            class="row-edit"
            :data-testid="`template-impact-edit-${row.item.kind}-${row.item.name}`"
            @click="navigateToItem(row.item)">
            Edit
          </button>
        </li>
      </ul>
      <p class="impact-footer">
        Future direction: a "Migrate with AI" action per affected row will land
        as an AI-task surface alongside <code>alt-text</code> per
        <code>design-ai.md</code>.
      </p>
    </template>
  </div>
</template>

<style scoped>
.template-impact {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem 1.5rem;
  font-size: 0.8125rem;
}
.impact-empty,
.impact-error {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--color-muted);
  padding: 1rem 0;
}
.impact-error {
  color: var(--color-danger-fg);
}
.impact-summary code {
  font-family: ui-monospace, monospace;
  background: var(--color-hover-bg);
  padding: 0.0625rem 0.25rem;
  border-radius: var(--p-border-radius-sm);
}
.summary-affected {
  color: var(--color-warning-fg);
}
.summary-clean {
  color: var(--color-muted);
}
.impact-rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.impact-row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: start;
  gap: 0.75rem;
  padding: 0.625rem 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: var(--p-border-radius-md);
  background: var(--color-bg);
}
.impact-row.severity-error {
  border-left: 3px solid var(--color-danger-fg);
}
.impact-row.severity-warn {
  border-left: 3px solid var(--color-warning-fg);
}
.impact-row.severity-info {
  border-left: 3px solid var(--color-info-fg);
}
.impact-row.severity-clean {
  border-left: 3px solid var(--color-success-fg);
}
.severity-error {
  color: var(--color-danger-fg);
}
.severity-warn {
  color: var(--color-warning-fg);
}
.severity-info {
  color: var(--color-info-fg);
}
.severity-clean {
  color: var(--color-success-fg);
}
.row-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}
.row-head {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}
.row-kind {
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-muted);
}
.row-name {
  font-weight: 600;
}
.row-issue-count {
  margin-inline-start: auto;
  color: var(--color-muted);
  font-size: 0.75rem;
}
.row-issues {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.row-issue {
  display: grid;
  grid-template-columns: minmax(2.5rem, auto) auto 1fr;
  gap: 0.5rem;
  padding: 0.25rem 0.5rem;
  border-radius: var(--p-border-radius-sm);
  background: var(--color-hover-bg);
  font-size: 0.75rem;
}
.issue-severity {
  text-transform: uppercase;
  font-weight: 600;
  font-size: 0.6875rem;
}
.issue-validator {
  font-family: ui-monospace, monospace;
  color: var(--color-muted);
}
.row-edit {
  align-self: center;
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: var(--p-border-radius-sm);
  padding: 0.25rem 0.625rem;
  color: var(--color-fg);
  font-size: 0.75rem;
  cursor: pointer;
}
.row-edit:hover {
  background: var(--color-hover-bg);
}
.impact-footer {
  margin: 0.5rem 0 0 0;
  color: var(--color-muted);
  font-size: 0.75rem;
  font-style: italic;
}
.impact-footer code {
  font-family: ui-monospace, monospace;
  font-style: normal;
  background: var(--color-hover-bg);
  padding: 0.0625rem 0.25rem;
  border-radius: var(--p-border-radius-sm);
}
</style>
