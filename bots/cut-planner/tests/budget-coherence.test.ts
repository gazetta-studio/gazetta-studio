/**
 * Cross-bot budget coherence.
 *
 * feature-bot counts HAND-OFFS; cut-planner decides what each hand-off
 * becomes (refine, or re-decompose once refinements run out). The two bots
 * deliberately share no code (design Q4), so nothing but this test keeps
 * their budgets consistent. If feature-bot's ceiling were lower than
 * cut-planner's two budgets summed, feature-bot would escalate terminally on
 * the hand-off cut-planner meant to re-decompose — the re-decomposition path
 * would exist, pass its own tests, and never run. That exact mismatch was
 * caught while arming (both knobs had been called MAX_REFINEMENTS).
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { routeAttemptOutcome } from '../../feature-bot/route-attempt.js'
import { dispatchRun, type RunDecision } from '../dispatch-run.js'

const BOTS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p: string) => readFileSync(resolve(BOTS, p), 'utf-8')

function defaultOf(src: string, name: string): number {
  const m = src.match(new RegExp(`const ${name} = Number\\(process\\.env\\.${name} \\?\\? '(\\d+)'\\)`))
  if (!m) throw new Error(`default for ${name} not found`)
  return Number(m[1])
}

describe('feature-bot ↔ cut-planner budgets', () => {
  const planner = read('cut-planner/index.ts')
  const featureBot = read('feature-bot/index.ts')

  it('feature-bot hands off exactly as often as cut-planner can use', () => {
    expect(defaultOf(featureBot, 'MAX_HANDOFFS')).toBe(
      defaultOf(planner, 'MAX_REFINEMENTS') + defaultOf(planner, 'MAX_REDECOMPOSITIONS'),
    )
  })

  it('is armed: refinement is reachable at all (Arming order)', () => {
    // Both at 0 would satisfy the equality above while leaving the whole
    // refine path dead — the state the design doc's Arming order forbids
    // once Cut 6 has shipped.
    expect(defaultOf(planner, 'MAX_REFINEMENTS')).toBeGreaterThan(0)
  })
})

describe('lifecycle — a cut that never lands, driven through BOTH bots’ real decision functions', () => {
  const planner = read('cut-planner/index.ts')
  const featureBot = read('feature-bot/index.ts')
  const MAX_HANDOFFS = defaultOf(featureBot, 'MAX_HANDOFFS')
  const MAX_REFINEMENTS = defaultOf(planner, 'MAX_REFINEMENTS')
  const MAX_REDECOMPOSITIONS = defaultOf(planner, 'MAX_REDECOMPOSITIONS')

  /** feature-bot exhausts its loop on substantive rejects; what does it route to? */
  const featureBotExhausts = (priorHandoffs: number) =>
    routeAttemptOutcome(
      { kind: 'agent-b-judged', signal: { kind: 'approve-implicit' }, verdict: { kind: 'reject', note: 'gap' } },
      { attempt: 2, maxAttempts: 2, priorInputCycles: 0, maxInputCycles: 2, priorHandoffs, maxHandoffs: MAX_HANDOFFS },
    ).kind

  /** cut-planner sees the cut in needs-refinement; what does it decide? */
  const plannerDecides = (priorRefinements: number, priorRedecompositions: number): RunDecision['kind'] =>
    dispatchRun({
      planner: { feature: 'f', designPath: 'd', suggestedPlan: '| 1 | a |', state: '', lockedDecisions: '' },
      plannerIssueNumber: 1,
      unverifiedClosedCuts: [],
      cuts: [
        {
          issueNumber: 7,
          needsRefinement: true,
          readyForAgent: false,
          hasOpenPr: false,
          priorRefinements,
          createdAt: 'x',
        },
      ],
      maxRefinements: MAX_REFINEMENTS,
      maxRedecompositions: MAX_REDECOMPOSITIONS,
      priorRedecompositions,
    }).kind

  it('original cut: refine, refine, then re-decompose — feature-bot never escalates on its own', () => {
    const trail: string[] = []
    let handoffs = 0
    let refinements = 0
    for (;;) {
      const fb = featureBotExhausts(handoffs)
      trail.push(`fb:${fb}`)
      if (fb !== 'escalate-needs-refinement') break
      handoffs++
      const cp = plannerDecides(refinements, 0)
      trail.push(`cp:${cp}`)
      if (cp !== 'refine') break
      refinements++
    }
    expect(trail).toEqual([
      'fb:escalate-needs-refinement',
      'cp:refine',
      'fb:escalate-needs-refinement',
      'cp:refine',
      'fb:escalate-needs-refinement',
      'cp:redecompose',
    ])
  })

  it('replacement cut (budget spent): refine, refine, then a human — via cut-planner, not feature-bot', () => {
    const trail: string[] = []
    let handoffs = 0
    let refinements = 0
    for (;;) {
      const fb = featureBotExhausts(handoffs)
      trail.push(`fb:${fb}`)
      if (fb !== 'escalate-needs-refinement') break
      handoffs++
      const cp = plannerDecides(refinements, MAX_REDECOMPOSITIONS)
      trail.push(`cp:${cp}`)
      if (cp !== 'refine') break
      refinements++
    }
    expect(trail.at(-1)).toBe('cp:escalate-cut')
    expect(trail.filter(t => t === 'cp:refine')).toHaveLength(MAX_REFINEMENTS)
    expect(trail).not.toContain('fb:escalate-needs-human')
  })
})
