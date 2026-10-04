/**
 * Issue-index tests. The classification order is the load-bearing part: a
 * cut in `needs-refinement` must never be mistaken for a planner issue,
 * and a pre-cut-planner tracking issue must never be escalated as one.
 */
import { describe, expect, it } from 'vitest'
import { classifyIssue, closedByPr, featureOf, type ListedIssue, lockBullets, observeCuts } from '../issue-index.js'
import { featureBotHandoffMarker, refinedMarker } from '../markers.js'
import { refinementMarker } from '../../feature-bot/refinement-handoff.js'

const CUT = '**Feature**: rw\n**Depends on**: none\n\n## Spec\n\nDo it.\n\n## Acceptance\n\n- a\n\n## Tests\n\n- t'
const PLANNER =
  '**Feature**: rw\n**Design**: .claude/rules/design-rw.md\n\n## Suggested plan\n\n| 1 | a |\n\n## State\n\nNext: cut 1'
const TRACKING = '**Feature**: rw\n\nTasklist:\n- [ ] #1\n- [ ] #2'

describe('classifyIssue', () => {
  it.each([
    ['a cut', CUT, 'cut'],
    ['a planner issue', PLANNER, 'planner'],
    [
      'a planner issue missing **Design** (still a planner — escalate, do not skip)',
      PLANNER.replace(/\*\*Design\*\*.*\n/, ''),
      'planner',
    ],
    ['a pre-cut-planner tracking issue', TRACKING, 'other'],
    ['an unrelated enhancement', 'Please add dark mode', 'other'],
    ['a null body', null, 'other'],
  ])('classifies %s', (_label, body, kind) => {
    expect(classifyIssue(body)).toBe(kind)
  })

  it('reads a cut in needs-refinement as a CUT even though it has a planner-ish shape', () => {
    // The regression this module exists for: such a cut is `enhancement`,
    // lacks `ready-for-agent`, and carries `**Feature**:`.
    expect(classifyIssue(`${CUT}\n\n## State\n\nstray`)).toBe('cut')
  })
})

describe('featureOf / closedByPr', () => {
  it('extracts the feature slug', () => {
    expect(featureOf(PLANNER)).toBe('rw')
    expect(featureOf('no front matter')).toBeNull()
  })

  it.each([
    ['Closes #12', [12]],
    ['fixes #3 and resolves #4', [3, 4]],
    ['Refs #9', []],
    [null, []],
  ])('closedByPr(%j)', (body, want) => {
    expect(closedByPr(body)).toEqual(want)
  })
})

describe('observeCuts', () => {
  const issue = (over: Partial<ListedIssue>): ListedIssue => ({
    number: 10,
    title: 't',
    body: CUT,
    labels: ['enhancement', 'ready-for-agent'],
    createdAt: '2026-10-01T00:00:00Z',
    ...over,
  })

  it('keeps only this feature’s cuts, skipping planners and other features', () => {
    const cuts = observeCuts(
      'rw',
      [
        issue({ number: 1 }),
        issue({ number: 2, body: PLANNER }),
        issue({ number: 3, body: CUT.replace('rw', 'other') }),
      ],
      [],
      new Map(),
    )
    expect(cuts.map(c => c.issueNumber)).toEqual([1])
  })

  it('derives labels, open-PR state and the refinement count', () => {
    const [c] = observeCuts(
      'rw',
      [issue({ number: 7, labels: ['enhancement', 'needs-refinement'] })],
      [{ number: 99, body: 'Closes #7' }],
      new Map([[7, [`x <!-- ${refinedMarker(7)} -->`, `y <!-- ${refinedMarker(8)} -->`, null]]]),
    )
    expect(c).toMatchObject({ needsRefinement: true, readyForAgent: false, hasOpenPr: true, priorRefinements: 1 })
  })
})

describe('lockBullets', () => {
  it('splits bullets, folds continuation lines, ignores comments and blanks', () => {
    const section =
      '<!-- seeded -->\n- `invalidateOnSave` compares `computeSaveEtag`,\n  NOT the publish hash (#837)\n\n* second lock'
    expect(lockBullets(section)).toEqual([
      '`invalidateOnSave` compares `computeSaveEtag`, NOT the publish hash (#837)',
      'second lock',
    ])
  })

  it('returns nothing for an empty section', () => {
    expect(lockBullets('')).toEqual([])
  })
})

describe('cross-bot marker contract', () => {
  it('reads exactly the hand-off tag feature-bot writes', () => {
    // The bots deliberately do not import each other (design Q4), so the
    // string is duplicated. This test is what keeps the copies identical: if
    // they drift, cut-planner stops seeing reviewer verdicts.
    expect(featureBotHandoffMarker(519)).toBe(refinementMarker(519))
  })
})
