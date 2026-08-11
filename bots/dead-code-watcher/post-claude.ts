/**
 * Post-Claude flow for `compact.ts` — the validation-before-prune
 * gate the compactor runs after `runClaude` returns.
 *
 * Pure function of `(claudeSucceeded, lessons file bytes, reviewer-log
 * file state, keepLast)`. Returns descriptive data; the caller wires
 * the outcome to observable side effects (warnings, exit code, notes).
 *
 * The load-bearing invariant: when Claude has written a `lessons-learned.md`
 * that fails the `findSignalCountViolations` gate, the reviewer-log MUST
 * NOT be pruned. If we pruned first (or in parallel), a drifting Claude
 * output would evict its own input — next month's re-run would then be
 * unable to reproduce the drift and regenerate cleanly. Ordering:
 *
 *   Claude fails       → skip both (preserve input for next month)
 *   Claude ok + drift  → fail (exit 1); DON'T prune
 *   Claude ok + clean  → prune to keepLast
 *
 * Extracted from `compact.ts` main() so the ordering can be unit-tested
 * without spawning Claude.
 */
import { existsSync, readFileSync } from 'node:fs'
import { pruneReviewerLog } from './reviewer-log.js'
import { findSignalCountViolations, type SignalCountViolation } from './signal-count-guard.js'

export interface PostClaudeInput {
  /** Did `runClaude` complete without throwing / non-zero-exit? */
  claudeSucceeded: boolean
  /** Absolute path to the lessons file Claude may have (re)written. */
  lessonsPath: string
  /** Absolute path to the reviewer-log Claude read as input + we may prune. */
  reviewerLogPath: string
  /** How many entries to keep in the reviewer-log after prune. */
  keepLast: number
}

export interface PostClaudeOutcome {
  /** 0 = continue the compaction run; 1 = fail (signal-count drift). */
  exitCode: 0 | 1
  /** Violations found in the lessons file. Empty when clean OR Claude did not succeed. */
  violations: SignalCountViolation[]
  /** Prune result when pruning ran. `null` when skipped: Claude failed, OR violations blocked it. */
  prune: { dropped: number; kept: number } | null
}

/**
 * Deterministic post-Claude flow.
 *
 * Precondition: the caller has already invoked `runClaude` (or equivalent)
 * and captured whether it succeeded. Claude may have modified the lessons
 * file at `lessonsPath`; the reviewer-log at `reviewerLogPath` is
 * untouched between Claude's read and this call.
 */
export function handlePostClaude(input: PostClaudeInput): PostClaudeOutcome {
  if (!input.claudeSucceeded) {
    return { exitCode: 0, violations: [], prune: null }
  }

  const lessonsContent = existsSync(input.lessonsPath) ? readFileSync(input.lessonsPath, 'utf-8') : ''
  const violations = findSignalCountViolations(lessonsContent)

  // Load-bearing: drift-then-return BEFORE the prune call. Structural
  // guarantee that a drifting lessons file cannot evict its own input.
  if (violations.length > 0) {
    return { exitCode: 1, violations, prune: null }
  }

  const prune = pruneReviewerLog(input.reviewerLogPath, input.keepLast)
  return { exitCode: 0, violations: [], prune }
}
