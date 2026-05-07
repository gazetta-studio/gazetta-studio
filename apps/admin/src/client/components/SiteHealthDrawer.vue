<script setup lang="ts">
/**
 * Site Health drawer (Validation Cut 2).
 *
 * Lists current issues from the background scanner, grouped by item.
 * Click an issue → navigate to the affected item; in-editor banner
 * shows the issue inline (Cut 1 surface).
 *
 * Per design-validation.md "Surfaces" + Krug rule 23: absence is the
 * state. The drawer shows only when opened from the toolbar; the
 * toolbar icon shows a count badge only when issues > 0.
 */
import { computed } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import { useRouter } from 'vue-router'
import { useValidationScannerStore } from '../stores/validationScanner.js'
import type { ValidationIssue } from '../api/client.js'

defineProps<{ visible: boolean }>()
const emit = defineEmits<{ (e: 'update:visible', v: boolean): void }>()

const router = useRouter()
const store = useValidationScannerStore()

interface ItemGroup {
  itemPath: string
  issues: readonly ValidationIssue[]
  worstSeverity: 'error' | 'warn' | 'info'
}

const SEVERITY_RANK: Record<'error' | 'warn' | 'info', number> = {
  error: 0,
  warn: 1,
  info: 2,
}

/** Issues grouped by item, sorted by worst severity. */
const groups = computed<ItemGroup[]>(() => {
  const out: ItemGroup[] = []
  for (const [itemPath, issues] of Object.entries(store.byItem)) {
    let worst: 'error' | 'warn' | 'info' = 'info'
    for (const issue of issues) {
      if (SEVERITY_RANK[issue.severity] < SEVERITY_RANK[worst]) worst = issue.severity
    }
    out.push({ itemPath, issues, worstSeverity: worst })
  }
  out.sort((a, b) => SEVERITY_RANK[a.worstSeverity] - SEVERITY_RANK[b.worstSeverity])
  return out
})

function close() {
  emit('update:visible', false)
}

function severityIcon(severity: 'error' | 'warn' | 'info'): string {
  if (severity === 'error') return 'pi pi-exclamation-circle'
  if (severity === 'warn') return 'pi pi-exclamation-triangle'
  return 'pi pi-info-circle'
}

/**
 * Map an item path (e.g., `pages/home/page.json` or
 * `fragments/header/fragment.json`) to a router-link route. Locale
 * variants (`page.fr.json`) navigate to the same item with the locale
 * pre-selected.
 */
function navigateToItem(itemPath: string) {
  const m = itemPath.match(/^pages\/(.+?)\/page(?:\.([a-zA-Z-]+))?\.json$/)
  if (m) {
    const [, name, locale] = m
    router.push({
      path: `/pages/${name}`,
      query: locale ? { locale } : undefined,
    })
    close()
    return
  }
  const f = itemPath.match(/^fragments\/(.+?)\/fragment(?:\.([a-zA-Z-]+))?\.json$/)
  if (f) {
    const [, name, locale] = f
    router.push({
      path: `/fragments/${name}`,
      query: locale ? { locale } : undefined,
    })
    close()
    return
  }
  // Unrecognized path shape — leave the drawer open so the operator can copy it
}
</script>

<template>
  <Dialog
    :visible="visible"
    @update:visible="emit('update:visible', $event)"
    modal
    header="Site health"
    :style="{ width: '720px', maxHeight: '80vh' }"
    :closable="true"
    data-testid="site-health-drawer"
  >
    <div v-if="store.fetchError" class="health-error">
      <i class="pi pi-exclamation-triangle"></i>
      Couldn't fetch issues: {{ store.fetchError }}
      <Button text size="small" label="Retry" @click="store.refresh()" />
    </div>
    <div v-else-if="groups.length === 0" class="health-empty">
      <i class="pi pi-check-circle health-clean-icon"></i>
      No issues found.
    </div>
    <div v-else class="health-list">
      <div
        v-for="group in groups"
        :key="group.itemPath"
        class="health-item"
        :data-testid="`health-item-${group.itemPath}`"
      >
        <button
          class="health-item-header"
          @click="navigateToItem(group.itemPath)"
          :aria-label="`Open ${group.itemPath} (${group.issues.length} issue${group.issues.length === 1 ? '' : 's'})`"
        >
          <i :class="severityIcon(group.worstSeverity)" :data-severity="group.worstSeverity"></i>
          <span class="health-item-path">{{ group.itemPath }}</span>
          <span class="health-item-count">{{ group.issues.length }}</span>
        </button>
        <ul class="health-issue-list">
          <li
            v-for="(issue, i) in group.issues"
            :key="i"
            :class="`health-issue health-issue-${issue.severity}`"
          >
            <i :class="severityIcon(issue.severity)" :data-severity="issue.severity"></i>
            <span class="health-issue-message">{{ issue.message }}</span>
            <code v-if="issue.contentPath" class="health-issue-path">{{ issue.contentPath }}</code>
          </li>
        </ul>
      </div>
    </div>
  </Dialog>
</template>

<style scoped>
.health-error {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 1rem;
  color: var(--p-red-600);
}

.health-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  padding: 2rem;
  color: var(--p-text-muted-color);
}

.health-clean-icon {
  font-size: 2rem;
  color: var(--p-green-500);
}

.health-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.health-item {
  border: 1px solid var(--p-content-border-color);
  border-radius: var(--p-border-radius-md);
  overflow: hidden;
}

.health-item-header {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: var(--p-content-hover-background);
  border: none;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  color: inherit;
  font-size: 0.875rem;
}

.health-item-header:hover {
  background: var(--p-content-background);
}

.health-item-path {
  flex: 1;
  font-family: ui-monospace, monospace;
  color: var(--p-text-color);
}

.health-item-count {
  color: var(--p-text-muted-color);
  font-size: 0.75rem;
}

.health-issue-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.health-issue {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border-top: 1px solid var(--p-content-border-color);
  font-size: 0.875rem;
}

.health-issue-message {
  flex: 1;
}

.health-issue-path {
  color: var(--p-text-muted-color);
  font-size: 0.75rem;
}

i[data-severity='error'] {
  color: var(--p-red-500);
}
i[data-severity='warn'] {
  color: var(--p-amber-500);
}
i[data-severity='info'] {
  color: var(--p-blue-500);
}
</style>
