/**
 * Parse fix-bot input issues to extract pre-loadable context.
 *
 * Mutation-watcher and flake-watcher both file issues that fix-bot will
 * consume; the issue bodies have predictable structure that the
 * orchestrator can mine for context BEFORE invoking Claude. The
 * alternative — having Claude re-derive everything from scratch via
 * Glob/Grep/Read tool calls — wastes turns and context, and was the
 * direct cause of fix-bot run 25639089938's autocompact thrash.
 *
 * Today this only handles mutation-watcher issues (source path is in a
 * known position). Flake-watcher issues have a similar structure (test
 * path) but we leave them alone until we see the equivalent pain point.
 */

/**
 * The source kind a fix-bot issue points at. `null` means we couldn't
 * confidently identify the issue's producer; in that case the
 * orchestrator falls back to letting Claude discover everything itself.
 */
export type IssueSource = 'mutation-watcher' | 'flake-watcher' | null

/**
 * Detect which producer bot filed this issue, by looking for outcome tags
 * (a project-wide convention — every bot comment / new-issue body ends
 * with `<!-- <bot>: <key>=<val> -->`). Outcome tags are forensic in
 * nature, but they also work as cheap producer-detection.
 */
export function detectIssueSource(body: string): IssueSource {
  if (/<!--\s*mutation-watcher:/.test(body)) return 'mutation-watcher'
  if (/<!--\s*flake-watcher:/.test(body)) return 'flake-watcher'
  return null
}

/**
 * For mutation-watcher issues, extract the source file path from the
 * issue body. Mutation-watcher's prompt locks the format:
 *
 *   Stryker found N actionable mutant(s) in `src/path/to/file.ts` on
 *
 * Returns the path string (relative to the package root, typically
 * starting with `src/`) or null if the body doesn't match.
 */
export function extractMutationSourcePath(body: string): string | null {
  const match = body.match(/Stryker found \d+ actionable mutant\(s\) in `([^`]+)`/)
  return match ? match[1] : null
}
