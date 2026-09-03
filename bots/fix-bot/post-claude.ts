/**
 * Post-Claude flow for fix-bot's `compact.ts` — the prune-only-on-success
 * gate the compactor runs after `runClaude` returns.
 *
 * Pure function of `(claudeSucceeded, reviewer-log file state, keepLast)`.
 * Returns descriptive data; the caller wires the outcome to observable
 * side effects (notices, run summary).
 *
 * The load-bearing invariant: when Claude fails, the reviewer-log MUST
 * NOT be pruned. If we pruned unconditionally, a failed compaction run
 * would evict its own input — next month's re-run would then have less
 * signal to reproduce or generalize from, silently degrading the
 * memory-compaction quality across monthly cron cycles.
 *
 *   Claude fails  → skip prune (preserve input for next month)
 *   Claude ok     → prune to keepLast
 *
 * Extracted from `compact.ts` main() so the ordering can be unit-tested
 * without spawning Claude. Symmetric with
 * `bots/dead-code-watcher/post-claude.ts` per team-preferences rule 38;
 * fix-bot's flow is simpler (no signal-count-violation gate).
 */
import { pruneReviewerLog } from './reviewer-log.js'

export interface PostClaudeInput {
  /** Did `runClaude` complete without throwing / non-zero-exit? */
  claudeSucceeded: boolean
  /** Absolute path to the reviewer-log we may prune. */
  reviewerLogPath: string
  /** How many entries to keep in the reviewer-log after prune. */
  keepLast: number
}

export interface PostClaudeOutcome {
  /** Prune result when pruning ran. `null` when skipped (Claude failed). */
  prune: { dropped: number; kept: number } | null
}

/**
 * Deterministic post-Claude flow.
 *
 * Precondition: the caller has already invoked `runClaude` (or equivalent)
 * and captured whether it succeeded.
 */
export function handlePostClaude(input: PostClaudeInput): PostClaudeOutcome {
  if (!input.claudeSucceeded) {
    return { prune: null }
  }
  const prune = pruneReviewerLog(input.reviewerLogPath, input.keepLast)
  return { prune }
}
