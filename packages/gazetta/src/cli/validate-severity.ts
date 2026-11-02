/**
 * The severity `gazetta validate` gives each validator's issues, where it
 * differs from the scan's (design-template-check.md T7). Site health keeps
 * the scan's severity; the CLI is the gate, so content that doesn't fit its
 * template fails it. One table, so the CLI's text, JSON and base comparison
 * read the same severities.
 */
import type { Issue } from '../validation/types.js'

export const CLI_SEVERITY: Readonly<Record<string, Issue['severity']>> = {
  'schema-conformance': 'error',
}

/** `issue` with the severity `gazetta validate` reports it at. */
export function withCliSeverity<T extends Pick<Issue, 'validator' | 'severity'>>(issue: T): T {
  const severity = CLI_SEVERITY[issue.validator]
  return severity && severity !== issue.severity ? { ...issue, severity } : issue
}
