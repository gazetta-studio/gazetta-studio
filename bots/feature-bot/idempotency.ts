/**
 * Idempotency decision — should we re-attempt a cut sub-issue that
 * already has the `feature-bot-attempted` label?
 *
 * Mirrors fix-bot's auto-clear-on-reopen pattern. The orchestrator
 * looks up the label-applied-at timestamp + the most-recent reopen
 * timestamp via bots/_lib/github.ts helpers, then calls this pure
 * function to decide.
 *
 * Split as a pure function so the rule can be tested without mocking
 * octokit. Rule 18 (SOLID at module creation): I/O lives in the
 * orchestrator; the decision rule lives here.
 */

export interface IdempotencyInput {
  /**
   * ISO timestamp when `feature-bot-attempted` was most recently
   * applied. Null when the label has never been applied OR is not
   * currently on the issue.
   */
  attemptedAt: string | null
  /**
   * ISO timestamp of the most recent `reopened` event on the issue.
   * Null when the issue has never been closed-and-reopened.
   */
  reopenedAt: string | null
}

export type IdempotencyDecision = { kind: 'proceed' } | { kind: 'skip' } | { kind: 'proceed-after-reopen' }

export function decideIdempotency(input: IdempotencyInput): IdempotencyDecision {
  if (input.attemptedAt === null) {
    return { kind: 'proceed' }
  }
  if (input.reopenedAt === null) {
    return { kind: 'skip' }
  }
  // Reopen at or after the label-applied time means the maintainer
  // signaled a re-attempt request. Tie favors proceeding (rare clock
  // tie should not strand the issue).
  if (input.reopenedAt >= input.attemptedAt) {
    return { kind: 'proceed-after-reopen' }
  }
  return { kind: 'skip' }
}
