import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { ValidationIssue } from '../api/client.js'

/**
 * Save-time validation banner state.
 *
 * Holds the issues from the most recent save attempt that returned 409
 * VALIDATION_FAILED. The banner clears on next successful save or explicit
 * dismiss.
 *
 * Cut 1 scope: save-delta issues only. Cut 2 will introduce a peer
 * `validationScanner` store for background-discovered issues; the two
 * surfaces stay distinct (banner vs site-tree dots vs Site Health drawer)
 * per design-validation.md.
 */
export const useValidationIssuesStore = defineStore('validationIssues', () => {
  const issues = ref<readonly ValidationIssue[]>([])

  const hasIssues = computed(() => issues.value.length > 0)
  const errorCount = computed(() => issues.value.filter(i => i.severity === 'error').length)

  function set(next: readonly ValidationIssue[]) {
    issues.value = next
  }

  function clear() {
    issues.value = []
  }

  return { issues, hasIssues, errorCount, set, clear }
})
