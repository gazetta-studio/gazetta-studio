/**
 * Attempt routing — pure decision function for the generator-critic loop.
 *
 * Given the outcome of one attempt (Agent A signal + optionally Agent B
 * verdict + attempt context), decide what the orchestrator should do
 * next:
 *
 *   - push-and-pr — Agent A approve-implicit + Agent B approve
 *   - retry-with-note — Agent A approve-implicit + Agent B reject + attempts remain
 *   - post-input-question — Agent A needs-input + cycle count under cap
 *   - escalate-needs-human — terminal escalation with a SkipReason
 *   - escalate-failure — Agent A non-zero exit; surface failure diagnostic
 *
 * Per design-feature-bot.md Q6 (three-tier escalation) + Q7 (extended
 * skip-list reason codes).
 *
 * Pure routing: the orchestrator owns I/O (gh CLI, octokit, git, claude
 * invocation). This module decides what to do given the inputs. Split per
 * rule 18: I/O and decision logic are different reasons-to-change.
 */
import type { SkipReason } from './skip-list.js'
import type { AgentASignal } from './agent-a-signal.js'
import type { ReviewerVerdict } from '../_lib/reviewer-verdict.js'

/** What the orchestrator just observed at the end of one attempt. */
export type AttemptOutcome =
  /** Agent A's claude invocation exited non-zero. */
  | { kind: 'agent-a-failure'; exitCode: number }
  /** Agent A's invocation succeeded but produced no commits AND no signal. */
  | { kind: 'agent-a-no-output' }
  /** Agent A emitted a NEEDS_INPUT or NEEDS_HUMAN signal (no commits expected). */
  | { kind: 'agent-a-signaled'; signal: Extract<AgentASignal, { kind: 'needs-input' | 'needs-human' }> }
  /** Agent A committed work (approve-implicit) AND Agent B has rendered a verdict. */
  | { kind: 'agent-b-judged'; signal: Extract<AgentASignal, { kind: 'approve-implicit' }>; verdict: ReviewerVerdict }

export interface RouteContext {
  /** Current attempt number (1-indexed). */
  attempt: number
  /** Cap on attempts before forcing escalate-needs-human. */
  maxAttempts: number
  /** How many NEEDS_INPUT cycles this cut has already gone through. */
  priorInputCycles: number
  /** Max NEEDS_INPUT cycles before escalating (per Q6 lock; default 2). */
  maxInputCycles: number
}

export type RouteDecision =
  | { kind: 'push-and-pr'; reasoning: string }
  | { kind: 'retry-with-note'; note: string }
  | { kind: 'post-input-question'; body: string; question: string }
  | { kind: 'escalate-needs-human'; reason: SkipReason; reasonNote: string }
  | { kind: 'escalate-failure'; exitCode: number }

export function routeAttemptOutcome(outcome: AttemptOutcome, ctx: RouteContext): RouteDecision {
  switch (outcome.kind) {
    case 'agent-a-failure':
      return { kind: 'escalate-failure', exitCode: outcome.exitCode }

    case 'agent-a-no-output':
      return {
        kind: 'escalate-needs-human',
        reason: 'needs-human',
        reasonNote: 'Agent A produced no commits and no signal block; cannot proceed.',
      }

    case 'agent-a-signaled':
      return routeAgentASignal(outcome.signal, ctx)

    case 'agent-b-judged':
      return routeAgentBVerdict(outcome.verdict, ctx)
  }
}

function routeAgentASignal(
  signal: Extract<AgentASignal, { kind: 'needs-input' | 'needs-human' }>,
  ctx: RouteContext,
): RouteDecision {
  if (signal.kind === 'needs-input') {
    // Cycle-count check: priorInputCycles already includes ALL prior
    // NEEDS_INPUT events on this cut. The cap is reached when
    // priorInputCycles >= maxInputCycles.
    if (ctx.priorInputCycles >= ctx.maxInputCycles) {
      return {
        kind: 'escalate-needs-human',
        reason: 'input-cycles-exceeded',
        reasonNote: `Agent A asked NEEDS_INPUT ${ctx.priorInputCycles} times without resolution; escalating per Q6 MAX_INPUT_REQUESTS=${ctx.maxInputCycles} cap.`,
      }
    }
    return { kind: 'post-input-question', body: signal.body, question: signal.question }
  }

  // signal.kind === 'needs-human' — passthrough the reason-code as the SkipReason.
  return {
    kind: 'escalate-needs-human',
    reason: signal.reasonCode,
    reasonNote: signal.reason,
  }
}

function routeAgentBVerdict(verdict: ReviewerVerdict, ctx: RouteContext): RouteDecision {
  if (verdict.kind === 'approve') {
    return { kind: 'push-and-pr', reasoning: verdict.reasoning }
  }
  if (verdict.kind === 'needs-human') {
    return {
      kind: 'escalate-needs-human',
      reason: 'wrong-root-cause',
      reasonNote: verdict.note,
    }
  }
  // verdict.kind === 'reject'
  if (ctx.attempt >= ctx.maxAttempts) {
    return {
      kind: 'escalate-needs-human',
      reason: 'needs-human',
      reasonNote: `Loop exhausted after ${ctx.maxAttempts} attempts. Last reviewer note: ${verdict.note}`,
    }
  }
  return { kind: 'retry-with-note', note: verdict.note }
}
