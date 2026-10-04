/**
 * Is this issue downstream of a design pass?
 *
 * Discovery precedes design, so an issue carrying `**Feature**:`
 * front-matter is never a discovery candidate: it is a cut-planner planner
 * issue, a cut sub-issue (including one handed back to cut-planner, whose
 * `needs-refinement` swap drops `ready-for-agent` and so makes it look like
 * an unresearched enhancement), or a pre-cut-planner tracking issue.
 *
 * Structural rather than label-based so one rule covers all three without
 * introducing a label. Matches the front-matter line only — a body that
 * merely mentions "Feature:" in prose is still researched.
 */
export function isDesignPassedWork(body: string): boolean {
  return /^\*\*Feature\*\*:[^\S\n]*\S/m.test(body)
}
