/**
 * Attempt routing — pure decision function for fix-bot's
 * generator-critic loop.
 *
 * Given the outcome of one attempt, decide what the orchestrator
 * should do next:
 *
 *   - stop-queue-rate-limited — Anthropic session-limit hit; the outer
 *     candidate loop should short-circuit (every subsequent issue's
 *     Agent A invocation would crash in seconds against the exhausted
 *     bucket).
 *   - post-failure-comment — Agent A crashed for non-rate-limit
 *     reasons; the orchestrator posts a failure-diagnostic comment +
 *     applies `ready-for-human` (existing `postFailureComment` path).
 *   - terminal-no-op — Agent A succeeded but produced no commits
 *     (took the STUCK path itself, or bailed no-op). Not the
 *     orchestrator's job to escalate — Agent A already made a
 *     terminal decision.
 *   - push-and-pr — Agent B approved; push branch + open PR.
 *   - retry-with-note — Agent B rejected AND attempts remain (see
 *     "Final-REJECT semantics" below).
 *   - escalate-needs-human — Agent B returned NEEDS_HUMAN.
 *
 * Pure routing: the orchestrator owns I/O (gh CLI, octokit, git,
 * claude invocation). This module decides what to do given the
 * inputs. Split per rule 18: I/O and decision logic are different
 * reasons-to-change. Rule-38 symmetric with feature-bot's
 * `route-attempt.ts` (the sibling that led this pattern).
 *
 * Not modeled here:
 *   - Agent B crash (`bResult.success === false`) — the orchestrator
 *     handles it inline before constructing the AttemptOutcome, same
 *     as feature-bot. Keeps the pure function focused on
 *     successful-invocation cases and preserves the transcript-path
 *     detail in the escalation reasonNote without threading it
 *     through the pure decision.
 *
 * Final-REJECT semantics: on `verdict.kind === 'reject'`, this
 * function returns `retry-with-note` regardless of whether attempts
 * remain. The orchestrator's for-loop guard (`attempt <= MAX_ATTEMPTS`)
 * exits naturally when the note has been recorded on the last
 * iteration. Feature-bot's sibling routes final REJECT to
 * `escalate-needs-human`; fix-bot diverges intentionally so the
 * observable behavior of the current orchestrator (loop-exit-then-
 * apply-attempted-label, no post-loop escalation) is preserved by
 * this extraction. Aligning the two sibling bots on the escalate
 * path is a separate decision that would change observable behavior
 * and belongs in its own change.
 */
import type { ReviewerVerdict } from '../_lib/reviewer-verdict.js'
import type { SkipReason } from './skip-list.js'

/** What the orchestrator just observed at the end of one attempt. */
export type AttemptOutcome =
  /** Agent A's claude invocation exited non-zero AND rate-limit was detected. */
  | { kind: 'agent-a-rate-limited' }
  /** Agent A's claude invocation exited non-zero for reasons other than rate-limit. */
  | { kind: 'agent-a-failure'; exitCode: number }
  /** Agent A succeeded but produced no commits on the branch (STUCK path or no-op). */
  | { kind: 'agent-a-no-output' }
  /** Agent A committed AND Agent B rendered a verdict on those commits. */
  | { kind: 'agent-b-judged'; verdict: ReviewerVerdict }

export interface RouteContext {
  /** Current attempt number (1-indexed). */
  attempt: number
  /** Cap on attempts before the orchestrator's for-loop exits. */
  maxAttempts: number
}

export type RouteDecision =
  | { kind: 'stop-queue-rate-limited' }
  | { kind: 'post-failure-comment'; exitCode: number }
  | { kind: 'terminal-no-op' }
  | { kind: 'push-and-pr'; reasoning: string }
  | { kind: 'retry-with-note'; note: string }
  | { kind: 'escalate-needs-human'; reason: SkipReason; reasonNote: string }

export function routeAttemptOutcome(outcome: AttemptOutcome, ctx: RouteContext): RouteDecision {
  switch (outcome.kind) {
    case 'agent-a-rate-limited':
      return { kind: 'stop-queue-rate-limited' }

    case 'agent-a-failure':
      return { kind: 'post-failure-comment', exitCode: outcome.exitCode }

    case 'agent-a-no-output':
      return { kind: 'terminal-no-op' }

    case 'agent-b-judged':
      return routeAgentBVerdict(outcome.verdict, ctx)
  }
}

function routeAgentBVerdict(verdict: ReviewerVerdict, ctx: RouteContext): RouteDecision {
  if (verdict.kind === 'approve') {
    return { kind: 'push-and-pr', reasoning: verdict.reasoning }
  }
  if (verdict.kind === 'needs-human') {
    return {
      kind: 'escalate-needs-human',
      reason: 'needs-human',
      reasonNote: `Reviewer verdict on attempt ${ctx.attempt}: ${verdict.note}`,
    }
  }
  // verdict.kind === 'reject' — see "Final-REJECT semantics" in the
  // module header. Always retry-with-note; the orchestrator's for-loop
  // guard exits naturally on the last iteration without escalating.
  return { kind: 'retry-with-note', note: verdict.note }
}
