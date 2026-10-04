/**
 * Outcome-tag markers cut-planner writes and later counts.
 *
 * Every budget in design-cut-planner.md Q6 is counted from tagged comments
 * rather than from committed state, so the same string has to be used to
 * WRITE a tag and to COUNT it. Keeping both sides here means they cannot
 * drift apart: a renamed marker that is emitted one way and counted another
 * would silently reset every budget to zero.
 */

/** A spec refinement cut-planner applied to a cut issue. */
export function refinedMarker(issueNumber: number): string {
  return `cut-planner: refined issue=${issueNumber}`
}

/** A re-decomposition, recorded on the planner issue (the budget is per feature). */
export function redecomposedMarker(feature: string): string {
  return `cut-planner: redecomposed feature=${feature}`
}

/** A terminal cut escalation cut-planner applied. */
export function escalatedCutMarker(issueNumber: number): string {
  return `cut-planner: escalated issue=${issueNumber}`
}

/** A feature-scope escalation on the planner issue. */
export function escalatedFeatureMarker(feature: string): string {
  return `cut-planner: escalated feature=${feature}`
}

/** A decision comment on the planner issue (filed / refined / deviated). */
export function decisionMarker(feature: string, action: string): string {
  return `cut-planner: ${action} feature=${feature}`
}

/** feature-bot's hand-off tag — authored by feature-bot, read here. */
export function featureBotHandoffMarker(issueNumber: number): string {
  return `feature-bot: needs-refinement issue=${issueNumber}`
}

/** Count bodies carrying `marker`. Defensive about null bodies (deleted comments). */
export function countMarked(bodies: readonly (string | null | undefined)[], marker: string): number {
  return bodies.filter(b => (b ?? '').includes(marker)).length
}

/** Wrap a marker as the trailing HTML-comment outcome tag. */
export function tag(marker: string, runId: string): string {
  return `<!-- ${marker} run=${runId} -->`
}
