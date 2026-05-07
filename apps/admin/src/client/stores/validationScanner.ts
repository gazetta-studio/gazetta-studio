/**
 * Background scanner issues store (Validation Cut 2).
 *
 * Holds the current accumulated issues across the site, populated from
 * `GET /api/validation/issues`. Subscribes to the SSE channel
 * `/__validation` to receive `validation-issues-updated` events emitted
 * by the scanner; on each event, the store re-fetches the issues list.
 *
 * Distinct from `useValidationIssuesStore` (save-time banner): the
 * banner shows issues from THIS save; the scanner store shows
 * accumulated state across the entire site, surfaced as site-tree
 * dots + Site Health drawer per design-validation.md.
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { ValidationIssue } from '../api/client.js'
import { API_BASE, apiUrl, authHeaders } from '../api/_request.js'

interface IssuesByItem {
  [itemPath: string]: ValidationIssue[]
}

export const useValidationScannerStore = defineStore('validationScanner', () => {
  const issues = ref<readonly ValidationIssue[]>([])
  const lastFetchedAt = ref<number | null>(null)
  const fetchError = ref<string | null>(null)

  /** Total issue count — drives the toolbar badge. */
  const total = computed(() => issues.value.length)

  /** Issues grouped by `itemPath`. Drives the drawer's per-item lists. */
  const byItem = computed<IssuesByItem>(() => {
    const out: IssuesByItem = {}
    for (const issue of issues.value) {
      const list = out[issue.itemPath] ?? []
      list.push(issue)
      out[issue.itemPath] = list
    }
    return out
  })

  /** Items that have at least one error-severity issue. Drives red dots. */
  const itemsWithErrors = computed(() => {
    const set = new Set<string>()
    for (const issue of issues.value) {
      if (issue.severity === 'error') set.add(issue.itemPath)
    }
    return set
  })

  /** Items that have warn-severity issues but no errors. Drives amber dots. */
  const itemsWithWarnings = computed(() => {
    const set = new Set<string>()
    for (const issue of issues.value) {
      if (issue.severity !== 'warn') continue
      if (itemsWithErrors.value.has(issue.itemPath)) continue
      set.add(issue.itemPath)
    }
    return set
  })

  /** Issues for one specific item (drawer click + editor banner integration). */
  function issuesFor(itemPath: string): readonly ValidationIssue[] {
    return byItem.value[itemPath] ?? []
  }

  /** Highest severity for an item — drives dot color. Returns null when clean. */
  function severityFor(itemPath: string): 'error' | 'warn' | 'info' | null {
    if (itemsWithErrors.value.has(itemPath)) return 'error'
    if (itemsWithWarnings.value.has(itemPath)) return 'warn'
    const list = byItem.value[itemPath]
    if (list && list.length > 0) return 'info'
    return null
  }

  /** Refresh from the server. Called on boot, on SSE event, on explicit retry. */
  async function refresh(): Promise<void> {
    try {
      // `apiUrl()` already prefixes API_BASE (which contains `/api`); the path
      // arg is relative to that base. Convention from sibling api modules.
      const res = await fetch(apiUrl('/validation/issues'), {
        headers: authHeaders(),
      })
      if (!res.ok) {
        fetchError.value = `HTTP ${res.status}`
        return
      }
      const body = (await res.json()) as { issues: ValidationIssue[]; total: number }
      issues.value = body.issues
      fetchError.value = null
      lastFetchedAt.value = Date.now()
    } catch (err) {
      fetchError.value = (err as Error).message
    }
  }

  let eventSource: EventSource | null = null

  /**
   * Open the SSE stream. Idempotent — repeated calls reuse the existing
   * connection. Reconnects automatically via EventSource's built-in retry.
   */
  function subscribe(): void {
    if (eventSource) return
    // /__validation is mounted on the OUTER Hono app at the site root
    // (matching `/__reload`'s placement) so dev-mode browsers reach it
    // without going through Vite's middleware. URL is the bare absolute
    // path; no admin or api prefix.
    const url = '/__validation'
    try {
      eventSource = new EventSource(url, { withCredentials: false })
      eventSource.addEventListener('validation-issues-updated', () => {
        void refresh()
      })
      eventSource.onerror = () => {
        // EventSource reconnects automatically; nothing to do here. Errors
        // before the first connect surface as `readyState === CLOSED`.
      }
    } catch {
      // Browser doesn't support EventSource OR the URL is malformed —
      // store still works via explicit refresh() calls; just no push.
      eventSource = null
    }
  }

  /** Close the SSE stream. Called on store dispose / admin teardown. */
  function unsubscribe(): void {
    if (eventSource) {
      eventSource.close()
      eventSource = null
    }
  }

  return {
    issues,
    total,
    byItem,
    itemsWithErrors,
    itemsWithWarnings,
    lastFetchedAt,
    fetchError,
    issuesFor,
    severityFor,
    refresh,
    subscribe,
    unsubscribe,
  }
})
