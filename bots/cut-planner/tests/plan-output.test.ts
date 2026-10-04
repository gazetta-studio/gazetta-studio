/**
 * Plan-output tests. The parser is the trust boundary between Claude's
 * judgement and cut-planner's GitHub writes, so the rejections matter more
 * than the happy path: anything malformed must come back `ok: false`, which
 * the executor escalates rather than guesses past (Q6a).
 */
import { describe, expect, it } from 'vitest'
import { parsePlanOutput, touchesWorkflows } from '../plan-output.js'

const fence = (o: unknown) => ['Some reasoning first.', `\`\`\`cut-plan\n${JSON.stringify(o)}\n\`\`\``]
const cut = {
  title: 'Gate saves on review state',
  spec: 'Reject saves while pending-review.',
  acceptance: ['409 EDIT_LOCKED during pending-review'],
  tests: ['packages/gazetta/tests/admin-api-review-save-lock.test.ts'],
  solid: 'SRP — manifest-save.ts owns orchestration.',
  lockIndices: [0],
  files: ['packages/gazetta/src/manifest-save.ts'],
}

describe('parsePlanOutput — happy paths', () => {
  it('parses a file action', () => {
    const r = parsePlanOutput(fence({ action: 'file', ...cut, state: 'In flight: cut 5', deviation: null }), 'file', 1)
    expect(r).toMatchObject({
      ok: true,
      value: { action: 'file', title: cut.title, deviation: null, lockIndices: [0] },
    })
  })

  it('takes the LAST fence when Claude drafted more than once', () => {
    const texts = [
      ...fence({ action: 'plan-complete', reason: 'draft' }),
      ...fence({ action: 'plan-complete', reason: 'final' }),
    ]
    expect(parsePlanOutput(texts, 'file', 0)).toMatchObject({ ok: true, value: { reason: 'final' } })
  })

  it('parses a redecompose with remaining pieces', () => {
    const r = parsePlanOutput(
      fence({ action: 'redecompose', first: cut, remaining: ['part b'], summary: 's', state: 'st' }),
      'redecompose',
      1,
    )
    expect(r).toMatchObject({ ok: true, value: { action: 'redecompose', remaining: ['part b'] } })
  })

  it('normalises an empty solid to null and de-duplicates lock indices', () => {
    const r = parsePlanOutput(
      fence({ action: 'refine', ...cut, solid: '  ', lockIndices: [0, 0], summary: 's' }),
      'refine',
      1,
    )
    expect(r).toMatchObject({ ok: true, value: { solid: null, lockIndices: [0] } })
  })
})

describe('parsePlanOutput — rejections', () => {
  it.each([
    ['no fence at all', ['just prose'], 'file'],
    ['invalid JSON', ['```cut-plan\n{nope\n```'], 'file'],
    ['an array', fence([1]), 'file'],
    ['an action not allowed in this mode (file → refine)', fence({ action: 'refine', ...cut, summary: 's' }), 'file'],
    ['an action not allowed in this mode (refine → file)', fence({ action: 'file', ...cut, state: 's' }), 'refine'],
    [
      'empty acceptance (feature-bot would bounce it)',
      fence({ action: 'file', ...cut, acceptance: [], state: 's' }),
      'file',
    ],
    ['empty tests (feature-bot would bounce it)', fence({ action: 'file', ...cut, tests: [''], state: 's' }), 'file'],
    [
      'an out-of-range lock index (Claude saw a different list)',
      fence({ action: 'file', ...cut, lockIndices: [3], state: 's' }),
      'file',
    ],
    ['a non-integer lock index', fence({ action: 'file', ...cut, lockIndices: [0.5], state: 's' }), 'file'],
    ['a non-string state', fence({ action: 'file', ...cut, state: 42 }), 'file'],
    [
      'a one-piece "split" (a refinement in disguise)',
      fence({ action: 'redecompose', first: cut, remaining: [], summary: 's', state: 's' }),
      'redecompose',
    ],
    [
      'a question with a single option',
      fence({ action: 'needs-input', question: 'q', options: ['a'], recommendation: 'a' }),
      'file',
    ],
    ['a design objection with no reason', fence({ action: 'design-objection' }), 'refine'],
  ] as const)('rejects %s', (_label, texts, mode) => {
    expect(parsePlanOutput(texts, mode, 1).ok).toBe(false)
  })
})

describe('touchesWorkflows (#840)', () => {
  it.each([
    [['.github/workflows/ci.yml'], true],
    [['./.github/workflows/x.yml'], true],
    [['packages/a.ts', '.github/workflows/ci.yml'], true],
    [['.github/ISSUE_TEMPLATE/bug.yml'], false],
    [['docs/workflows.md'], false],
    [[], false],
  ])('%j → %s', (files, want) => {
    expect(touchesWorkflows(files)).toBe(want)
  })
})

describe('parsePlanOutput — the first live answer (#857, run 37223010207)', () => {
  it('accepts a file answer with no state and no deviation — both are optional', () => {
    // The real answer was well-formed except that it omitted `state` (the
    // prompt only showed it in shorthand). Rejecting it escalated a good cut
    // to a human; `## State` is derived data, so the executor fills it in.
    const real = {
      action: 'file',
      title: "Point README's cut-planner section at the design doc's Implementation notes",
      spec: 'In `bots/README.md`, add exactly one sentence…',
      acceptance: ['`bots/README.md` has exactly one new sentence…'],
      tests: ['manual verification — open `bots/README.md` on the PR branch…'],
      solid: null,
      lockIndices: [0, 1],
      files: ['bots/README.md'],
    }
    expect(parsePlanOutput(fence(real), 'file', 2)).toMatchObject({
      ok: true,
      value: { state: null, deviation: null, lockIndices: [0, 1] },
    })
  })

  it('accepts a redecompose answer with no state', () => {
    const r = parsePlanOutput(
      fence({ action: 'redecompose', first: cut, remaining: ['b'], summary: 's' }),
      'redecompose',
      1,
    )
    expect(r).toMatchObject({ ok: true, value: { state: null } })
  })
})
