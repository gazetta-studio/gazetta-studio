import type { ValidationScanner } from '../../src/validation/scanner.js'
import type { Issue } from '../../src/validation/types.js'

/** A scanner holding a fixed set of issues; scans do nothing. */
export function fakeScanner(issues: readonly Issue[]): ValidationScanner {
  return {
    async scanAll() {},
    async rescan() {},
    allIssues: () => issues,
    issuesFor: path => issues.filter(i => i.itemPath === path),
    subscribe: () => () => {},
  }
}
