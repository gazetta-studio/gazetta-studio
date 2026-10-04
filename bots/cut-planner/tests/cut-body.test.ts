/**
 * Cut-body renderer tests.
 *
 * The important ones assert against the REAL consumer —
 * `bots/_lib/cut-parser.ts`, which feature-bot's pre-Claude
 * `validateCutSubIssue` gate runs on every candidate. A body that fails
 * that parser would be filed and then immediately bounced, so asserting
 * against a local idea of the shape would prove nothing.
 */
import { describe, expect, it } from 'vitest'
import { parseCutBody, validateParsedCut } from '../../_lib/cut-parser.js'
import { filedCutMarker, renderCutBody, type CutBodyInput } from '../cut-body.js'

/** Parse + validate with the REAL gate feature-bot runs. */
function validate(body: string) {
  return validateParsedCut(parseCutBody(body))
}

const base: CutBodyInput = {
  feature: 'review-workflow',
  designPath: '.claude/rules/design-review-workflow.md',
  spec: 'Gate edits on review state. Make the change in `manifest-save.ts`, not the two route shims.',
  acceptance: ['Save during `pending-review` → 409 EDIT_LOCKED', 'Save during `approved` + content changed → `draft`'],
  tests: ['`packages/gazetta/tests/admin-api-review-save-lock.test.ts` — 409 on pending-review'],
  solid: 'SRP — `manifest-save.ts` owns save orchestration; it delegates the review decision to the state machine.',
  lockedDecisions: ['`invalidateOnSave` compares `computeSaveEtag(manifest)`, NOT the publish-state hash (#837)'],
  runId: '12345',
}

describe('renderCutBody — satisfies the real cut-parser', () => {
  it('produces a body feature-bot accepts', () => {
    expect(validate(renderCutBody(base))).toEqual([])
  })

  it('still parses without the optional SOLID section', () => {
    // Pure-data-shape and pure-docs cuts legitimately omit it.
    expect(validate(renderCutBody({ ...base, solid: undefined }))).toEqual([])
  })

  it('still parses with no locked decisions to transcribe', () => {
    expect(validate(renderCutBody({ ...base, lockedDecisions: [] }))).toEqual([])
  })

  it('exposes the feature slug to the parser', () => {
    expect(parseCutBody(renderCutBody(base)).feature).toBe('review-workflow')
  })
})

describe('renderCutBody — content contract (Q2)', () => {
  it('transcribes locked decisions into the body', () => {
    // Q2: a cut body carries functional requirements AND technical
    // suggestions, provided each traces to an already-locked decision.
    // #519 failed three times because its spec DEFERRED the decision
    // ("Resolve open-Q #2 here") instead of stating it.
    const body = renderCutBody(base)
    expect(body).toContain('computeSaveEtag(manifest)')
    expect(body).toMatch(/do not re-decide/i)
  })

  it('cites the design doc as provenance for the locks', () => {
    const body = renderCutBody(base)
    expect(body).toContain('.claude/rules/design-review-workflow.md')
  })

  it('omits the SOLID heading entirely rather than emitting it empty', () => {
    // An empty `## SOLID` is worse than none: a reader cannot tell "N/A"
    // from "forgotten".
    const body = renderCutBody({ ...base, solid: '   ' })
    expect(body).not.toContain('## SOLID')
  })

  it('omits the locks block rather than emitting an empty one', () => {
    const body = renderCutBody({ ...base, lockedDecisions: undefined })
    expect(body).not.toMatch(/Locked decisions/i)
  })
})

describe('renderCutBody — Depends on', () => {
  it('emits `none` explicitly rather than omitting the field', () => {
    // Q1 removed the need for dependency tracking by filing one cut at a
    // time; ordering is enforced by Q5a step 2. Emitting an explicit
    // `none` tells a human the omission is intentional.
    expect(renderCutBody(base)).toContain('**Depends on**: none')
  })

  it('produces a body whose dependency list the parser reads as empty', () => {
    expect(parseCutBody(renderCutBody(base)).dependsOn).toEqual([])
  })
})

describe('renderCutBody — bullets + outcome tag', () => {
  it('adds bullet markers to bare lines but not to pre-bulleted ones', () => {
    const body = renderCutBody({ ...base, acceptance: ['bare line', '- already bulleted'] })
    expect(body).toContain('- bare line')
    expect(body).not.toContain('- - already bulleted')
  })

  it('drops blank entries rather than emitting empty bullets', () => {
    const body = renderCutBody({ ...base, tests: ['real test', '', '   '] })
    expect(body).not.toMatch(/^- *$/m)
  })

  it('carries the outcome tag so a future run can find what it filed', () => {
    const body = renderCutBody(base)
    expect(body).toContain(filedCutMarker('review-workflow'))
    expect(body).toContain('run=12345')
  })
})
