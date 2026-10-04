/**
 * Run-dispatcher tests.
 *
 * Q5a's precedence is the thing most likely to regress: "file the next
 * cut" is the obvious action, and feedback-first is the counter-intuitive
 * one. Most of these tests pin the ORDER rather than the individual
 * branches.
 */
import { describe, expect, it } from 'vitest'
import { dispatchRun, type ObservedCut, type RunObservation } from '../dispatch-run.js'
import type { PlannerIssue } from '../planner-issue.js'

const planner: PlannerIssue = {
  feature: 'review-workflow',
  designPath: '.claude/rules/design-review-workflow.md',
  suggestedPlan: '| 5 | save-handler gates pending-review | 4 | api-first | Medium |',
  state: 'Landed: cuts 1-4\nNext: cut 5',
  lockedDecisions: '- invalidateOnSave compares computeSaveEtag (#837)',
}

const cut = (over: Partial<ObservedCut> = {}): ObservedCut => ({
  issueNumber: 519,
  needsRefinement: false,
  readyForAgent: false,
  hasOpenPr: false,
  priorRefinements: 0,
  createdAt: '2026-06-14T00:00:00Z',
  ...over,
})

const obs = (over: Partial<RunObservation> = {}): RunObservation => ({
  planner,
  plannerIssueNumber: 900,
  cuts: [],
  maxRefinements: 2,
  maxRedecompositions: 1,
  priorRedecompositions: 0,
  ...over,
})

describe('dispatchRun — Q5a precedence', () => {
  it('refines before filing, even when the plan has cuts left', () => {
    // THE load-bearing assertion. A pending refinement is evidence about
    // the PLAN, not just that cut — filing the next one first propagates
    // the defect.
    const d = dispatchRun(obs({ cuts: [cut({ needsRefinement: true })] }))
    expect(d.kind).toBe('refine')
  })

  it('refines before filing, even when another cut is also in flight', () => {
    // Step 1 outranks step 2, not just step 3.
    const d = dispatchRun(
      obs({
        cuts: [cut({ issueNumber: 520, readyForAgent: true }), cut({ issueNumber: 519, needsRefinement: true })],
      }),
    )
    expect(d.kind).toBe('refine')
    if (d.kind === 'refine') expect(d.issueNumber).toBe(519)
  })

  it('does not file while a cut is ready-for-agent', () => {
    const d = dispatchRun(obs({ cuts: [cut({ readyForAgent: true })] }))
    expect(d).toEqual({ kind: 'idle', because: 'cut-in-flight' })
  })

  it('does not file while a cut has an open PR awaiting review', () => {
    const d = dispatchRun(obs({ cuts: [cut({ hasOpenPr: true })] }))
    expect(d).toEqual({ kind: 'idle', because: 'cut-in-flight' })
  })

  it('files the next cut only when nothing is pending or in flight', () => {
    expect(dispatchRun(obs()).kind).toBe('file-next')
  })

  it('files when prior cuts exist but are all closed and unlabelled', () => {
    // A landed cut leaves neither label and no open PR.
    const d = dispatchRun(obs({ cuts: [cut({ issueNumber: 515 }), cut({ issueNumber: 516 })] }))
    expect(d.kind).toBe('file-next')
  })
})

describe('dispatchRun — oldest-first within the refinement queue', () => {
  it('picks the oldest pending refinement', () => {
    const d = dispatchRun(
      obs({
        cuts: [
          cut({ issueNumber: 521, needsRefinement: true, createdAt: '2026-08-01T00:00:00Z' }),
          cut({ issueNumber: 519, needsRefinement: true, createdAt: '2026-06-14T00:00:00Z' }),
        ],
      }),
    )
    expect(d.kind).toBe('refine')
    if (d.kind === 'refine') expect(d.issueNumber).toBe(519)
  })

  it('breaks a createdAt tie by issue number, deterministically', () => {
    // Same-second creation must not make the pick order non-deterministic
    // — a maintainer should be able to predict which cut the bot takes.
    const same = '2026-06-14T00:00:00Z'
    const d = dispatchRun(
      obs({
        cuts: [
          cut({ issueNumber: 521, needsRefinement: true, createdAt: same }),
          cut({ issueNumber: 519, needsRefinement: true, createdAt: same }),
        ],
      }),
    )
    if (d.kind === 'refine') expect(d.issueNumber).toBe(519)
    else throw new Error(`expected refine, got ${d.kind}`)
  })
})

describe('dispatchRun — Q6 budgets', () => {
  it('re-decomposes once the refinement budget is spent', () => {
    const d = dispatchRun(obs({ cuts: [cut({ needsRefinement: true, priorRefinements: 2 })] }))
    expect(d).toEqual({ kind: 'redecompose', issueNumber: 519 })
  })

  it('escalates the CUT once both budgets are spent', () => {
    const d = dispatchRun(
      obs({ cuts: [cut({ needsRefinement: true, priorRefinements: 2 })], priorRedecompositions: 1 }),
    )
    expect(d.kind).toBe('escalate-cut')
    if (d.kind === 'escalate-cut') {
      expect(d.issueNumber).toBe(519)
      expect(d.reason).toBe('redecomposition-failed')
    }
  })

  it('reports refinement-exhausted when re-decomposition was never available', () => {
    // maxRedecompositions: 0 — the reason must say which budget ran out,
    // because a skip entry reading "refinement-exhausted" carries different
    // information from "redecomposition-failed".
    const d = dispatchRun(obs({ cuts: [cut({ needsRefinement: true, priorRefinements: 2 })], maxRedecompositions: 0 }))
    if (d.kind === 'escalate-cut') expect(d.reason).toBe('refinement-exhausted')
    else throw new Error(`expected escalate-cut, got ${d.kind}`)
  })

  it('still refines on the last allowed attempt', () => {
    const d = dispatchRun(obs({ cuts: [cut({ needsRefinement: true, priorRefinements: 1 })] }))
    expect(d.kind).toBe('refine')
  })
})

describe('dispatchRun — feature-scope escalation', () => {
  it('escalates the FEATURE when the plan is exhausted', () => {
    // Ambiguous — feature done, or seeding incomplete? Q6a says resolve
    // ambiguity toward a human rather than guessing.
    const d = dispatchRun(obs({ planner: { ...planner, suggestedPlan: '' } }))
    expect(d).toEqual({ kind: 'escalate-feature', reason: 'plan-exhausted' })
  })

  it('treats a whitespace-only plan as exhausted', () => {
    const d = dispatchRun(obs({ planner: { ...planner, suggestedPlan: '   \n\n  ' } }))
    expect(d.kind).toBe('escalate-feature')
  })

  it('drains feedback even when the plan is exhausted', () => {
    // Step 1 outranks the step-3 escalation too: a pending refinement is
    // still worth doing on a feature whose plan has run out.
    const d = dispatchRun(obs({ planner: { ...planner, suggestedPlan: '' }, cuts: [cut({ needsRefinement: true })] }))
    expect(d.kind).toBe('refine')
  })
})

describe('dispatchRun — totality', () => {
  it('returns a decision for every input shape (no undefined fall-through)', () => {
    // Q6a's rule is a DEFAULT, not a closed list: an unanticipated
    // combination must still resolve to something actionable rather than
    // falling through.
    const shapes: RunObservation[] = [
      obs(),
      obs({ cuts: [cut()] }),
      obs({ cuts: [cut({ needsRefinement: true, readyForAgent: true, hasOpenPr: true })] }),
      obs({ planner: { ...planner, suggestedPlan: '', state: '' } }),
      obs({ maxRefinements: 0, cuts: [cut({ needsRefinement: true })] }),
      obs({ cuts: [cut({ needsRefinement: true }), cut({ issueNumber: 520, hasOpenPr: true })] }),
    ]
    for (const s of shapes) {
      const d = dispatchRun(s)
      expect(d).toBeDefined()
      expect(typeof d.kind).toBe('string')
    }
  })

  it('with maxRefinements 0, a handed-back cut re-decomposes rather than looping', () => {
    // Guards the arming order: MAX_REFINEMENTS defaults to 0 until Cut 6
    // lands, and a cut that somehow reaches the queue must not spin.
    const d = dispatchRun(obs({ maxRefinements: 0, cuts: [cut({ needsRefinement: true })] }))
    expect(d.kind).toBe('redecompose')
  })
})
