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
import { CircleAlert, CircleCheck, Info, TriangleAlert } from '@lucide/vue'
import { type Component, computed } from 'vue'
import Dialog from './ui/Dialog.vue'
import Button from './ui/Button.vue'
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

function severityIcon(severity: 'error' | 'warn' | 'info'): Component {
  if (severity === 'error') return CircleAlert
  if (severity === 'warn') return TriangleAlert
  return Info
}

const SEVERITY_LABEL: Record<'error' | 'warn' | 'info', string> = { error: 'Error', warn: 'Warning', info: 'Info' }

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
      <TriangleAlert class="health-icon" aria-hidden="true" />
      Couldn't fetch issues: {{ store.fetchError }}
      <Button text size="small" label="Retry" @click="store.refresh()" />
    </div>
    <div v-else-if="groups.length === 0" class="health-empty">
      <CircleCheck class="health-clean-icon" aria-hidden="true" />
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
          <component :is="severityIcon(group.worstSeverity)" class="health-icon" :data-severity="group.worstSeverity" aria-hidden="true" />
          <span class="health-item-path">{{ group.itemPath }}</span>
          <span class="health-item-count">{{ group.issues.length }}</span>
        </button>
        <ul class="health-issue-list">
          <li
            v-for="(issue, i) in group.issues"
            :key="i"
            :class="`health-issue health-issue-${issue.severity}`"
          >
            <component
              :is="severityIcon(issue.severity)"
              class="health-icon"
              :data-severity="issue.severity"
              role="img"
              aria-hidden="false"
              :aria-label="SEVERITY_LABEL[issue.severity]" />
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
  color: var(--color-danger);
}

.health-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  padding: 2rem;
  color: var(--color-muted);
}

.health-icon {
  inline-size: 1rem;
  block-size: 1rem;
  flex: none;
}

.health-clean-icon {
  inline-size: 2rem;
  block-size: 2rem;
  color: var(--color-success);
}

.health-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.health-item {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.health-item-header {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: var(--color-hover-bg);
  border: none;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  color: inherit;
  font-size: 0.875rem;
}

.health-item-header:hover {
  background: var(--color-bg);
}

.health-item-path {
  flex: 1;
  font-family: var(--font-mono);
  color: var(--color-fg);
}

.health-item-count {
  color: var(--color-muted);
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
  border-top: 1px solid var(--color-border);
  font-size: 0.875rem;
}

.health-issue-message {
  flex: 1;
}

.health-issue-path {
  color: var(--color-muted);
  font-size: 0.75rem;
}

.health-icon[data-severity='error'] {
  color: var(--color-danger);
}
.health-icon[data-severity='warn'] {
  color: var(--color-warn);
}
.health-icon[data-severity='info'] {
  color: var(--color-info);
}
</style>
