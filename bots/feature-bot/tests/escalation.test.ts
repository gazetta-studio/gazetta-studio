/**
 * Escalation routing tests — failing-test commit per rule 31 TDD-first ordering.
 *
 * Tests the pure routing logic that decides what to do given:
 *   - Agent A's signal (approve-implicit / needs-input / needs-human)
 *   - Agent B's verdict (approve / reject / needs-human) — when Agent A
 *     was approve-implicit and committed work
 *
 * The orchestrator is an I/O layer (file system, octokit, git, claude
 * invocations); separating the routing logic from I/O lets us test the
 * three-tier escalation Q6 lock without mocking the entire world.
 *
 * Per design-feature-bot.md Q6:
 *   - APPROVE_IMPLICIT + Agent B APPROVE → push branch + open PR
 *   - APPROVE_IMPLICIT + Agent B REJECT → reset + retry up to MAX_ATTEMPTS
 *   - APPROVE_IMPLICIT + Agent B NEEDS_HUMAN → escalate (reason: wrong-root-cause)
 *   - NEEDS_INPUT (cycle count < MAX_INPUT_REQUESTS) → post structured Q +
 *     needs-info label, reset working tree
 *   - NEEDS_INPUT (cycle count >= MAX_INPUT_REQUESTS) → escalate
 *     (reason: input-cycles-exceeded)
 *   - NEEDS_HUMAN → escalate with the reason-code from the signal
 */
import { describe, expect, it } from 'vitest'
import type { AgentASignal } from '../agent-a-signal.js'
import { routeAttemptOutcome, type RouteContext, type RouteDecision } from '../route-attempt.js'
import type { ReviewerVerdict } from '../../_lib/reviewer-verdict.js'

const baseCtx: RouteContext = {
  attempt: 1,
  maxAttempts: 5,
  priorInputCycles: 0,
  maxInputCycles: 2,
}

describe('routeAttemptOutcome — agent-a-failure', () => {
  it('routes agent-a non-zero exit → escalate needs-human', () => {
    const decision = routeAttemptOutcome({ kind: 'agent-a-failure', exitCode: 1 }, baseCtx)
    expect(decision.kind).toBe('escalate-failure')
  })

  it('routes agent-a no-commits + no-signal → escalate needs-human', () => {
    // Agent A produced nothing — no commits, no NEEDS_INPUT, no NEEDS_HUMAN.
    // Treat as agent-a-failure with reason `needs-human` (catch-all).
    const decision = routeAttemptOutcome({ kind: 'agent-a-no-output' }, baseCtx)
    expect(decision.kind).toBe('escalate-needs-human')
    if (decision.kind === 'escalate-needs-human') {
      expect(decision.reason).toBe('needs-human')
    }
  })
})

describe('routeAttemptOutcome — APPROVE_IMPLICIT + reviewer verdict', () => {
  it('Agent B APPROVE → push-and-pr', () => {
    const signal: AgentASignal = { kind: 'approve-implicit' }
    const verdict: ReviewerVerdict = { kind: 'approve', reasoning: 'fix is minimal and the test pins it' }
    const decision = routeAttemptOutcome({ kind: 'agent-b-judged', signal, verdict }, baseCtx)
    expect(decision.kind).toBe('push-and-pr')
  })

  it('Agent B REJECT and attempts remain → retry-with-note', () => {
    const signal: AgentASignal = { kind: 'approve-implicit' }
    const verdict: ReviewerVerdict = { kind: 'reject', note: 'test is tautological' }
    const decision = routeAttemptOutcome({ kind: 'agent-b-judged', signal, verdict }, baseCtx)
    expect(decision.kind).toBe('retry-with-note')
    if (decision.kind === 'retry-with-note') {
      expect(decision.note).toBe('test is tautological')
    }
  })

  it('Agent B REJECT on final attempt, refinements remain → escalate-needs-refinement', () => {
    // Per design-cut-planner.md Q5: loop exhaustion on a SUBSTANTIVE reject
    // is the one place the spec is plausibly at fault, so it hands off to
    // cut-planner rather than terminating. Non-terminal: no skip-list entry,
    // the cut stays open, and the label swap (Cut 2) re-queues it for
    // cut-planner instead of feature-bot.
    const signal: AgentASignal = { kind: 'approve-implicit' }
    const verdict: ReviewerVerdict = { kind: 'reject', note: 'architecture gap at manifest-save.ts:329' }
    const decision = routeAttemptOutcome(
      { kind: 'agent-b-judged', signal, verdict },
      { ...baseCtx, attempt: 5, maxAttempts: 5, priorHandoffs: 0, maxHandoffs: 2 },
    )
    expect(decision.kind).toBe('escalate-needs-refinement')
    if (decision.kind === 'escalate-needs-refinement') {
      // The reviewer's note must travel with the handoff — per
      // design-cut-planner.md Q6, "a refinement that doesn't quote Agent B's
      // note is just a retry".
      expect(decision.reviewerNote).toBe('architecture gap at manifest-save.ts:329')
    }
  })

  it('Agent B REJECT on final attempt, refinement budget spent → escalate-needs-human', () => {
    // Q6 budgets: once 2 refinements + 1 re-decomposition are exhausted, the
    // spec is not the problem (or not one cut-planner can fix) and the cut
    // terminates with a skip-list entry.
    const signal: AgentASignal = { kind: 'approve-implicit' }
    const verdict: ReviewerVerdict = { kind: 'reject', note: 'still wrong' }
    const decision = routeAttemptOutcome(
      { kind: 'agent-b-judged', signal, verdict },
      { ...baseCtx, attempt: 5, maxAttempts: 5, priorHandoffs: 2, maxHandoffs: 2 },
    )
    expect(decision.kind).toBe('escalate-needs-human')
    if (decision.kind === 'escalate-needs-human') {
      expect(decision.reason).toBe('refinement-exhausted')
    }
  })

  it('Agent B NEEDS_HUMAN never routes to refinement, even with budget left', () => {
    // Q5: a design objection is terminal for the cut. Refining a spec cannot
    // answer "this architecture is wrong", so the refinement budget is
    // irrelevant here.
    const signal: AgentASignal = { kind: 'approve-implicit' }
    const verdict: ReviewerVerdict = { kind: 'needs-human', note: 'the whole approach is wrong' }
    const decision = routeAttemptOutcome(
      { kind: 'agent-b-judged', signal, verdict },
      { ...baseCtx, attempt: 1, maxAttempts: 5, priorHandoffs: 0, maxHandoffs: 2 },
    )
    expect(decision.kind).toBe('escalate-needs-human')
    if (decision.kind === 'escalate-needs-human') {
      expect(decision.reason).toBe('wrong-root-cause')
    }
  })

  it('agent-a-failure never routes to refinement — infrastructure, not spec', () => {
    // Q5 + Q6's quota-vs-budget lock: spawn E2BIG / non-zero exits say
    // nothing about the spec. Refining cannot fix a transport bug, and
    // misattributing infra to content is the error that made #526's skip
    // entry read "the cut is likely too large" about a budget bug.
    const decision = routeAttemptOutcome(
      { kind: 'agent-a-failure', exitCode: 143 },
      { ...baseCtx, priorHandoffs: 0, maxHandoffs: 2 },
    )
    expect(decision.kind).toBe('escalate-failure')
  })

  it('Agent B NEEDS_HUMAN → escalate-needs-human (reason: wrong-root-cause)', () => {
    const signal: AgentASignal = { kind: 'approve-implicit' }
    const verdict: ReviewerVerdict = { kind: 'needs-human', note: 'fix is at wrong layer' }
    const decision = routeAttemptOutcome({ kind: 'agent-b-judged', signal, verdict }, baseCtx)
    expect(decision.kind).toBe('escalate-needs-human')
    if (decision.kind === 'escalate-needs-human') {
      expect(decision.reason).toBe('wrong-root-cause')
    }
  })
})

describe('routeAttemptOutcome — NEEDS_INPUT cycles', () => {
  it('cycle count under cap → post-input-question', () => {
    const signal: AgentASignal = {
      kind: 'needs-input',
      question: 'should it 200 or 201?',
      body: 'NEEDS_INPUT: should it 200 or 201?\nOptions:\n  - 200\n  - 201\nRecommendation: 200',
    }
    const decision = routeAttemptOutcome({ kind: 'agent-a-signaled', signal }, { ...baseCtx, priorInputCycles: 0 })
    expect(decision.kind).toBe('post-input-question')
  })

  it('cycle count = cap - 1 → post-input-question (last allowed)', () => {
    const signal: AgentASignal = {
      kind: 'needs-input',
      question: 'q',
      body: 'NEEDS_INPUT: q',
    }
    const decision = routeAttemptOutcome(
      { kind: 'agent-a-signaled', signal },
      { ...baseCtx, priorInputCycles: 1, maxInputCycles: 2 },
    )
    expect(decision.kind).toBe('post-input-question')
  })

  it('cycle count = cap → escalate-needs-human (reason: input-cycles-exceeded)', () => {
    const signal: AgentASignal = {
      kind: 'needs-input',
      question: 'q',
      body: 'NEEDS_INPUT: q',
    }
    const decision = routeAttemptOutcome(
      { kind: 'agent-a-signaled', signal },
      { ...baseCtx, priorInputCycles: 2, maxInputCycles: 2 },
    )
    expect(decision.kind).toBe('escalate-needs-human')
    if (decision.kind === 'escalate-needs-human') {
      expect(decision.reason).toBe('input-cycles-exceeded')
    }
  })
})

describe('routeAttemptOutcome — NEEDS_HUMAN from Agent A', () => {
  it('Agent A NEEDS_HUMAN with missing-prereq → escalate with that reason', () => {
    const signal: AgentASignal = {
      kind: 'needs-human',
      reason: 'infrastructure absent',
      reasonCode: 'missing-prereq',
    }
    const decision = routeAttemptOutcome({ kind: 'agent-a-signaled', signal }, baseCtx)
    expect(decision.kind).toBe('escalate-needs-human')
    if (decision.kind === 'escalate-needs-human') {
      expect(decision.reason).toBe('missing-prereq')
    }
  })

  it('Agent A NEEDS_HUMAN with spec-too-vague → escalate with that reason', () => {
    const signal: AgentASignal = {
      kind: 'needs-human',
      reason: 'spec missing acceptance items',
      reasonCode: 'spec-too-vague',
    }
    const decision = routeAttemptOutcome({ kind: 'agent-a-signaled', signal }, baseCtx)
    if (decision.kind === 'escalate-needs-human') {
      expect(decision.reason).toBe('spec-too-vague')
    } else {
      throw new Error(`expected escalate-needs-human, got ${decision.kind}`)
    }
  })

  it('Agent A NEEDS_HUMAN with files-conflict → escalate with that reason', () => {
    const signal: AgentASignal = {
      kind: 'needs-human',
      reason: 'files open in another PR',
      reasonCode: 'files-conflict',
    }
    const decision = routeAttemptOutcome({ kind: 'agent-a-signaled', signal }, baseCtx)
    expect(decision.kind).toBe('escalate-needs-human')
    if (decision.kind === 'escalate-needs-human') {
      expect(decision.reason).toBe('files-conflict')
    }
  })

  it('Agent A NEEDS_HUMAN with generic (no reason-code) → escalate needs-human', () => {
    const signal: AgentASignal = {
      kind: 'needs-human',
      reason: 'generic',
      reasonCode: 'needs-human',
    }
    const decision: RouteDecision = routeAttemptOutcome({ kind: 'agent-a-signaled', signal }, baseCtx)
    expect(decision.kind).toBe('escalate-needs-human')
    if (decision.kind === 'escalate-needs-human') {
      expect(decision.reason).toBe('needs-human')
    }
  })
})
