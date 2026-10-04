/**
 * Run dispatcher — pure decision function for one cut-planner run.
 *
 * Given what the run observed about a feature, decide the ONE action to
 * take. Per design-cut-planner.md Q5a the order is fixed:
 *
 *   1. refinement queue non-empty?        → refine the oldest, STOP
 *   2. a cut still open and in flight?    → STOP, file nothing
 *   3. otherwise                          → file the next cut
 *
 * Feedback-first, one action per run.
 *
 * Why feedback outranks filing: a cut in `needs-refinement` is evidence
 * about the PLAN, not just that cut. If cut 5 failed because its spec
 * deferred a decision, cut 6 — drafted from the same design doc by the
 * same process — plausibly shares the defect. Filing it first propagates
 * the error. That is #519's failure mode at feature scale: its spec sat
 * four months carrying "Resolve open-Q #2 here" precisely because nothing
 * forced a re-read before moving on.
 *
 * Why one action per run: cut-planner's writes are not transactional — it
 * edits the planner body, creates or relabels a cut issue, and appends a
 * comment as three separate API calls. Capping at one action bounds an
 * interrupted run to leaving a single cut in a knowable state.
 *
 * Pure routing, I/O-free, peer to feature-bot's route-attempt.ts. The
 * orchestrator owns octokit and Claude invocation; this module only
 * decides. Rule 18: I/O and decision logic are different
 * reasons-to-change.
 */
import type { PlannerIssue } from './planner-issue.js'

/** A cut sub-issue belonging to this feature, as observed this run. */
export interface ObservedCut {
  issueNumber: number
  /** True when the cut carries `needs-refinement` — feature-bot handed it back. */
  needsRefinement: boolean
  /** True when the cut carries `ready-for-agent` — feature-bot may still pick it up. */
  readyForAgent: boolean
  /** True when an open PR references this cut (awaiting review or merge). */
  hasOpenPr: boolean
  /** How many times cut-planner has already refined this cut's spec. */
  priorRefinements: number
  /** ISO-8601 creation timestamp; used to pick the OLDEST of several. */
  createdAt: string
}

export interface RunObservation {
  planner: PlannerIssue
  plannerIssueNumber: number
  /** Cut sub-issues for this feature, in any order. */
  cuts: readonly ObservedCut[]
  /** Budget from design-cut-planner.md Q6; default 2. */
  maxRefinements: number
  /** Re-decomposition budget; default 1. */
  maxRedecompositions: number
  /** How many re-decompositions this feature has already had. */
  priorRedecompositions: number
}

export type RunDecision =
  /** Revise the spec of a cut feature-bot handed back (Q5a step 1). */
  | { kind: 'refine'; issueNumber: number; priorRefinements: number }
  /**
   * Refinement budget spent on this cut; try splitting it instead
   * (Q6: 2 refinements → 1 re-decomposition → terminal).
   */
  | { kind: 'redecompose'; issueNumber: number }
  /** Both budgets spent — this cut needs a human (Q6a, cut scope). */
  | { kind: 'escalate-cut'; issueNumber: number; reason: 'refinement-exhausted' | 'redecomposition-failed' }
  /** The feature itself is blocked — needs a human (Q6a, feature scope). */
  | { kind: 'escalate-feature'; reason: 'plan-exhausted' }
  /** File the next cut from the suggested plan (Q5a step 3). */
  | { kind: 'file-next' }
  /**
   * Nothing to do. NOT an escalation: a cut legitimately in flight means
   * "come back next run", and Q6a is explicit that this is not a failure.
   * `because` exists so the run summary can say which case it was rather
   * than printing a bare "idle".
   */
  | { kind: 'idle'; because: 'cut-in-flight' | 'no-planner-state' }

/**
 * Decide the single action for this run.
 *
 * Deliberately total: every input shape returns a decision, so an
 * unanticipated combination cannot fall through to undefined behaviour.
 * That is Q6a's rule stated as a default — "if cut-planner cannot complete
 * the job, it files for a human" — rather than as a closed list of
 * triggers.
 */
export function dispatchRun(obs: RunObservation): RunDecision {
  // ---- Step 1: drain feedback. -------------------------------------
  // Oldest first so a cut cannot be starved by newer siblings arriving in
  // the queue ahead of it.
  const pending = obs.cuts
    .filter(c => c.needsRefinement)
    .slice()
    .sort((a, b) =>
      a.createdAt === b.createdAt ? a.issueNumber - b.issueNumber : a.createdAt.localeCompare(b.createdAt),
    )

  const oldest = pending[0]
  if (oldest) {
    if (oldest.priorRefinements < obs.maxRefinements) {
      return { kind: 'refine', issueNumber: oldest.issueNumber, priorRefinements: oldest.priorRefinements }
    }
    // Refinement budget spent. Re-decomposition is the FALLBACK, not the
    // primary path (Q6) — CORAL's refine-before-decompose ordering, and
    // our own evidence that every diagnosed failure was mechanical or
    // spec-mode rather than spec-SIZE.
    if (obs.priorRedecompositions < obs.maxRedecompositions) {
      return { kind: 'redecompose', issueNumber: oldest.issueNumber }
    }
    return {
      kind: 'escalate-cut',
      issueNumber: oldest.issueNumber,
      reason: obs.priorRedecompositions > 0 ? 'redecomposition-failed' : 'refinement-exhausted',
    }
  }

  // ---- Step 2: is a cut still in flight? ---------------------------
  // `ready-for-agent` means feature-bot may still pick it up; an open PR
  // means it is awaiting review. Either way the feature's next cut is not
  // ours to file yet: dependencies here are IMPLICIT (Q1 dropped
  // `**Depends on**` by filing one at a time), so getting ahead silently
  // breaks the only mechanism that sequences the feature.
  const inFlight = obs.cuts.find(c => c.readyForAgent || c.hasOpenPr)
  if (inFlight) return { kind: 'idle', because: 'cut-in-flight' }

  // ---- Step 3: file the next cut. ----------------------------------
  // An empty suggested plan with no cuts in flight is ambiguous — either
  // the feature is done or seeding was incomplete — and Q6a says resolve
  // ambiguity toward a human rather than guessing.
  if (obs.planner.suggestedPlan.trim() === '') {
    return { kind: 'escalate-feature', reason: 'plan-exhausted' }
  }

  return { kind: 'file-next' }
}
