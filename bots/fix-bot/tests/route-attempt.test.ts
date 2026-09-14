/**
 * Routing tests — failing-test commit per rule 31 TDD-first ordering.
 *
 * Tests the pure routing logic that decides what fix-bot's orchestrator
 * should do given the outcome of one attempt:
 *   - Agent A's invocation (rate-limited / failed / succeeded-no-output)
 *   - Agent B's verdict (approve / reject / needs-human) when Agent A
 *     produced commits
 *
 * The orchestrator is an I/O layer (git, gh CLI, octokit, filesystem);
 * separating routing from I/O lets these tests cover every verdict
 * branch with typed inputs and zero mocks. Rule-38 symmetric with
 * feature-bot's escalation tests (`bots/feature-bot/tests/escalation.test.ts`).
 *
 * Current fix-bot semantics preserved by these tests:
 *   - rate-limited → stop-queue-rate-limited (outer loop returns
 *     `{ rateLimited: true }` to short-circuit the whole cron)
 *   - agent-a exit non-zero (not rate-limit) → post-failure-comment
 *     (orchestrator calls postFailureComment + applies ready-for-human)
 *   - agent-a no commits → terminal-no-op (Agent A took its own STUCK
 *     path or bailed; no escalation from the orchestrator)
 *   - verdict APPROVE → push-and-pr
 *   - verdict REJECT (any attempt) → retry-with-note. Fix-bot today
 *     never escalates on final-attempt REJECT — the loop exits
 *     naturally and the post-loop code takes no action. The pure
 *     function preserves this by NOT emitting escalate-needs-human on
 *     final REJECT (see design note in route-attempt.ts).
 *   - verdict NEEDS_HUMAN → escalate-needs-human (reason: needs-human)
 */
import { describe, expect, it } from 'vitest'
import type { ReviewerVerdict } from '../../_lib/reviewer-verdict.js'
import { routeAttemptOutcome, type RouteContext } from '../route-attempt.js'

const baseCtx: RouteContext = {
  attempt: 1,
  maxAttempts: 5,
}

describe('routeAttemptOutcome — Agent A invocation outcomes', () => {
  it('rate-limited → stop-queue-rate-limited', () => {
    const decision = routeAttemptOutcome({ kind: 'agent-a-rate-limited' }, baseCtx)
    expect(decision.kind).toBe('stop-queue-rate-limited')
  })

  it('non-zero exit (not rate-limit) → post-failure-comment carrying the exitCode', () => {
    const decision = routeAttemptOutcome({ kind: 'agent-a-failure', exitCode: 42 }, baseCtx)
    expect(decision.kind).toBe('post-failure-comment')
    if (decision.kind === 'post-failure-comment') {
      expect(decision.exitCode).toBe(42)
    }
  })

  it('succeeded but no commits → terminal-no-op (Agent A took STUCK path or bailed)', () => {
    const decision = routeAttemptOutcome({ kind: 'agent-a-no-output' }, baseCtx)
    expect(decision.kind).toBe('terminal-no-op')
  })
})

describe('routeAttemptOutcome — Agent B verdicts', () => {
  it('APPROVE → push-and-pr carrying reviewer reasoning', () => {
    const verdict: ReviewerVerdict = {
      kind: 'approve',
      reasoning: 'test pins the bug; fix is minimal',
    }
    const decision = routeAttemptOutcome({ kind: 'agent-b-judged', verdict }, baseCtx)
    expect(decision.kind).toBe('push-and-pr')
    if (decision.kind === 'push-and-pr') {
      expect(decision.reasoning).toBe('test pins the bug; fix is minimal')
    }
  })

  it('REJECT with attempts remaining → retry-with-note carrying reviewer note', () => {
    const verdict: ReviewerVerdict = {
      kind: 'reject',
      note: 'the test asserts on observed output',
    }
    const decision = routeAttemptOutcome({ kind: 'agent-b-judged', verdict }, { attempt: 2, maxAttempts: 5 })
    expect(decision.kind).toBe('retry-with-note')
    if (decision.kind === 'retry-with-note') {
      expect(decision.note).toBe('the test asserts on observed output')
    }
  })

  it('REJECT on final attempt → retry-with-note (preserves current fix-bot semantics; the orchestrator loop exits naturally on the next guard check without escalating)', () => {
    // Fix-bot's orchestrator loop: on reject at attempt=MAX_ATTEMPTS,
    // the inline routing sets priorReviewerNote and continues; the
    // for-loop guard then evaluates false and exits without ever
    // escalating. The `'rejected-loop-exhausted'` enum branch in
    // fixOneIssue's post-loop code has always been unreachable (the
    // reject path never assigns the enum value that would trigger
    // it). This test pins the preserved-behavior contract of the
    // extraction: no verdict routes differently through the pure
    // function than the inline routing did.
    const verdict: ReviewerVerdict = {
      kind: 'reject',
      note: 'still tautological',
    }
    const decision = routeAttemptOutcome({ kind: 'agent-b-judged', verdict }, { attempt: 5, maxAttempts: 5 })
    expect(decision.kind).toBe('retry-with-note')
    if (decision.kind === 'retry-with-note') {
      expect(decision.note).toBe('still tautological')
    }
  })

  it('NEEDS_HUMAN → escalate-needs-human with reason=needs-human and note incorporating attempt + reviewer note', () => {
    const verdict: ReviewerVerdict = {
      kind: 'needs-human',
      note: 'fix is at the wrong layer; needs redesign',
    }
    const decision = routeAttemptOutcome({ kind: 'agent-b-judged', verdict }, { attempt: 3, maxAttempts: 5 })
    expect(decision.kind).toBe('escalate-needs-human')
    if (decision.kind === 'escalate-needs-human') {
      expect(decision.reason).toBe('needs-human')
      // reasonNote must carry the attempt number + the reviewer's note
      // so escalateToHuman's downstream comment/skip-list entry names
      // both when the escalation happened and why.
      expect(decision.reasonNote).toContain('attempt 3')
      expect(decision.reasonNote).toContain('fix is at the wrong layer')
    }
  })
})
