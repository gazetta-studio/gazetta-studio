/**
 * Pure decision helpers for `compact.ts`.
 *
 * Extracted so the compactor's four load-bearing gates are covered by
 * unit tests without spawning the whole script (whose top-level
 * `main().catch(...)` fires on import). Each helper pins one
 * invariant that a mutation testing pass would fault-inject:
 *
 *   - `computeCompactPhase` — which of the two compaction surfaces
 *     (skip-list glob compaction, lessons-learned rewrite) run this
 *     month based on the current input sizes.
 *
 *   - `shouldPruneReviewerLog` — the "prune only when Claude
 *     succeeded" invariant. A failed Claude run must NOT prune the
 *     log; next month's run needs the same input to retry.
 *
 *   - `checkLessonsDrift` — the "signal-count violations fail the
 *     run" gate, ALSO gated on Claude succeeding. A drift check on a
 *     file Claude never wrote to would flag pre-existing content the
 *     current run isn't responsible for.
 *
 * These are pure — no filesystem, no environment reads, no clock.
 * `compact.ts` supplies the arguments after doing its own I/O.
 */

import { findSignalCountViolations, type SignalCountViolation } from './signal-count-guard.js'

export type CompactPhase =
  /** Both thresholds unmet — nothing to do. */
  | 'skip-both-below-thresholds'
  /** Skip-list eligible, lessons not — run rule compaction only. */
  | 'skip-list-only'
  /** Lessons eligible, skip-list not — rewrite lessons only. */
  | 'lessons-only'
  /** Both eligible — run the full compaction. */
  | 'both'

export interface CompactPhaseInput {
  skipListEntries: number
  reviewerLogEntries: number
  minEntriesForCompaction: number
  minReviewerLogForLessons: number
}

/**
 * Decide which compaction phase(s) run this cron based on input sizes.
 *
 * Eligibility per surface is `count >= threshold` — a surface at
 * exactly its threshold IS eligible (the compactor should engage as
 * soon as the minimum signal accumulates, not wait for one more).
 */
export function computeCompactPhase(input: CompactPhaseInput): CompactPhase {
  const skipListEligible = input.skipListEntries >= input.minEntriesForCompaction
  const lessonsEligible = input.reviewerLogEntries >= input.minReviewerLogForLessons

  if (!skipListEligible && !lessonsEligible) return 'skip-both-below-thresholds'
  if (skipListEligible && !lessonsEligible) return 'skip-list-only'
  if (!skipListEligible && lessonsEligible) return 'lessons-only'
  return 'both'
}

/**
 * Return true iff the reviewer-log should be pruned after this run.
 *
 * Pruning happens ONLY when Claude succeeded — if the run failed the
 * lessons rewrite likely didn't land, and next month's compactor
 * needs the same reviewer-log window to retry with. Dropping the
 * entries now would erase the input to the retry.
 */
export function shouldPruneReviewerLog(claudeSucceeded: boolean): boolean {
  return claudeSucceeded
}

export interface DriftCheckResult {
  /** True = the run should fail (process.exit(1)). */
  fail: boolean
  /** Violations to report (empty when `fail` is false). */
  violations: SignalCountViolation[]
}

/**
 * Check the freshly-written lessons file for signal-count drift.
 *
 * Runs the arithmetic guard ONLY when Claude succeeded — a drift
 * check on a file Claude never wrote would flag pre-existing
 * content the current run isn't responsible for.
 *
 * Returns `{ fail: true, violations }` to signal the compactor
 * should print the violations and exit(1) before the PR opens
 * with drifting content.
 */
export function checkLessonsDrift(input: { claudeSucceeded: boolean; lessonsContent: string }): DriftCheckResult {
  if (!input.claudeSucceeded) return { fail: false, violations: [] }
  const violations = findSignalCountViolations(input.lessonsContent)
  return { fail: violations.length > 0, violations }
}
