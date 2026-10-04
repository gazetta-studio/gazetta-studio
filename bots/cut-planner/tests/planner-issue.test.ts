/**
 * Planner-issue parser tests.
 *
 * The parser is cut-planner's only input (design-cut-planner.md open-Q 4),
 * so its failure modes matter more than its happy path: a malformed planner
 * issue is a FEATURE-scope escalation per Q6a, and the escalation comment
 * needs to name what was missing rather than saying "it didn't parse".
 */
import { describe, expect, it } from 'vitest'
import { parsePlannerIssue, replaceSection } from '../planner-issue.js'

const WELL_FORMED = `**Feature**: review-workflow
**Design**: .claude/rules/design-review-workflow.md

## Suggested plan

| # | What | Depends on | Test tier | Risk |
|---|---|---|---|---|
| 5 | save-handler gates pending-review | 4 | api-first | Medium |
| 6 | audit integration | 4 | api-first | Low |

## State

Landed: cuts 1-4 (#515-#518)
In flight: —
Next: cut 5

## Locked decisions

- \`invalidateOnSave: 'content-diff'\` compares \`computeSaveEtag(manifest)\`,
  NOT the publish-state hash (#837)
`

describe('parsePlannerIssue — well-formed', () => {
  it('extracts both front-matter fields', () => {
    const r = parsePlannerIssue(WELL_FORMED)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.feature).toBe('review-workflow')
    expect(r.value.designPath).toBe('.claude/rules/design-review-workflow.md')
  })

  it('slices the three sections without bleeding into each other', () => {
    const r = parsePlannerIssue(WELL_FORMED)
    if (!r.ok) throw new Error('expected ok')
    // The plan must carry its rows but NOT the State heading that follows.
    expect(r.value.suggestedPlan).toContain('save-handler gates pending-review')
    expect(r.value.suggestedPlan).not.toContain('Landed:')
    expect(r.value.state).toContain('Next: cut 5')
    expect(r.value.state).not.toContain('invalidateOnSave')
    expect(r.value.lockedDecisions).toContain('computeSaveEtag')
  })

  it('keeps a `###` subsection with its parent section', () => {
    // A planner issue that grows "### Deviations" under ## State must not
    // silently truncate — the comment log is the audit trail, but the body
    // is what the bot reads each run.
    const withSub = WELL_FORMED.replace('In flight: —', '### Deviations\n\nFolded cut 7 into 6.\n\nIn flight: —')
    const r = parsePlannerIssue(withSub)
    if (!r.ok) throw new Error('expected ok')
    expect(r.value.state).toContain('Folded cut 7 into 6')
  })
})

describe('parsePlannerIssue — malformed', () => {
  it('names a missing **Feature**', () => {
    const r = parsePlannerIssue('**Design**: x.md\n\n## State\nNext: cut 1')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.missing).toContain('**Feature**')
    expect(r.missing).not.toContain('**Design**')
  })

  it('names a missing **Design**', () => {
    const r = parsePlannerIssue('**Feature**: foo\n\n## State\nNext: cut 1')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.missing).toContain('**Design**')
  })

  it('names BOTH when the body is unrelated prose', () => {
    const r = parsePlannerIssue('just some notes about a feature')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.missing).toEqual(['**Feature**', '**Design**'])
  })

  it('rejects a present-but-empty front-matter field', () => {
    // `**Feature**:` with nothing after it is malformed, not a feature
    // named "". Treating it as valid would name cuts after an empty slug.
    const r = parsePlannerIssue('**Feature**:\n**Design**: x.md')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.missing).toContain('**Feature**')
  })
})

describe('parsePlannerIssue — optional sections', () => {
  it('accepts a freshly seeded issue with empty State', () => {
    // Legitimate: nothing has landed yet.
    const r = parsePlannerIssue(
      '**Feature**: foo\n**Design**: x.md\n\n## Suggested plan\n\n| # | What |\n|---|---|\n| 1 | a |',
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.state).toBe('')
  })

  it('accepts a feature with no locked decisions yet', () => {
    const r = parsePlannerIssue('**Feature**: foo\n**Design**: x.md\n\n## State\nNext: cut 1')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.lockedDecisions).toBe('')
  })

  it('returns an empty plan rather than failing when the section is absent', () => {
    // Whether an empty plan means "feature done" or "seeding incomplete" is
    // the run dispatcher's judgement (Cut 4), not the parser's.
    const r = parsePlannerIssue('**Feature**: foo\n**Design**: x.md')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.suggestedPlan).toBe('')
  })
})

describe('replaceSection', () => {
  const body =
    '**Feature**: f\n**Design**: d.md\n\n## Suggested plan\n\n| 1 | a |\n\n## State\n\nold\n### Deviations\n\nkept? no\n\n## Locked decisions\n\n- lock'

  it('replaces ## State (including its ### subsection) and leaves neighbours verbatim', () => {
    const out = replaceSection(body, 'State', 'Next: cut 2')
    expect(out).toContain('## State\n\nNext: cut 2\n')
    expect(out).not.toContain('old')
    expect(out).toContain('## Suggested plan\n\n| 1 | a |')
    expect(out).toContain('## Locked decisions\n\n- lock')
  })

  it('round-trips with the parser: what is written is what is read back', () => {
    const out = replaceSection(body, 'State', 'Landed: cut 1\nNext: cut 2')
    const parsed = parsePlannerIssue(out)
    if (!parsed.ok) throw new Error('expected ok')
    expect(parsed.value.state).toBe('Landed: cut 1\nNext: cut 2')
    expect(parsed.value.lockedDecisions).toBe('- lock')
  })

  it('appends the section when absent (a freshly seeded planner)', () => {
    const out = replaceSection('**Feature**: f\n**Design**: d.md', 'State', 'Next: cut 1')
    expect(out.endsWith('## State\n\nNext: cut 1\n')).toBe(true)
  })
})
