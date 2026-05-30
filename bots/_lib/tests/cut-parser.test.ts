/**
 * Cut-sub-issue parser tests — failing-test commit per rule 31 TDD-first
 * ordering. Spec sourced from design-feature-bot.md Q2 (just-markdown body
 * shape) + Q3 (dependency mechanism: regex-parse `**Depends on**:` with
 * cron-tick validation) + Cut 5 refinement (four sections: Spec /
 * Acceptance / SOLID / Tests; SOLID conditional).
 *
 * Two surfaces under test:
 *   - `parseCutBody(body)` — pure regex / split parse over markdown.
 *     No GitHub queries. Returns `ParsedCut` with `feature`,
 *     `dependsOn`, and four sections (`spec`, `acceptance`, `solid`,
 *     `tests`).
 *   - `validateParsedCut(parsed, ownIssueNumber?)` — pure-TS structural
 *     validation. Does NOT detect `not-found` or `not-a-cut` (those
 *     need GitHub queries; orchestrator handles those in Cut 3).
 *     Detects: missing feature, missing required sections (spec /
 *     acceptance / tests — but NOT solid; SOLID is conditionally
 *     required per Q6 lock), and self-reference when `ownIssueNumber`
 *     matches a depNumber.
 *
 * Per rule 31: "do not modify the failing tests" during implementation.
 * The tests below are the spec.
 */
import { describe, expect, it } from 'vitest'
import { parseCutBody, type ParsedCut, validateParsedCut, type ValidationError } from '../cut-parser.js'

// ---------------------------------------------------------------------------
// parseCutBody — happy path
// ---------------------------------------------------------------------------

const FULL_BODY = `**Feature**: redirect-ui
**Depends on**: #501, #502

## Spec

Build the CreateRedirectDialog.vue component. Reuses the morph-in-place
pattern from CreatePageDialog.vue. See design-redirect-ui.md Q3 for the
+ New menu entry decision.

## Acceptance

- Dialog opens from SiteTree's "+ New redirect" button
- From / To inputs accept both \`/path\` and bare names
- Submit calls POST /api/redirects with correct body shape

## SOLID

- SRP: component owns dialog UX only; reuses ArchivedNameConflictPrompt
- Composition: consumes shared prompt rather than extending it

## Tests

- apps/admin/tests/CreateRedirectDialog.test.ts — open + close + submit
- apps/admin/tests/CreateRedirectDialog.test.ts — kind toggle updates body
- apps/admin/tests/CreateRedirectDialog.test.ts — 409 morph to conflict prompt
`

describe('parseCutBody — happy path', () => {
  it('parses a fully-populated body with all four sections', () => {
    const parsed = parseCutBody(FULL_BODY)
    expect(parsed.feature).toBe('redirect-ui')
    expect(parsed.dependsOn).toEqual([501, 502])
    expect(parsed.spec).toBeDefined()
    expect(parsed.spec).toContain('CreateRedirectDialog.vue')
    expect(parsed.acceptance).toBeDefined()
    expect(parsed.acceptance).toContain('Dialog opens')
    expect(parsed.solid).toBeDefined()
    expect(parsed.solid).toContain('SRP')
    expect(parsed.tests).toBeDefined()
    expect(parsed.tests).toContain('CreateRedirectDialog.test.ts')
  })
})

// ---------------------------------------------------------------------------
// parseCutBody — empty / missing front-matter fields
// ---------------------------------------------------------------------------

describe('parseCutBody — empty body', () => {
  it('returns null feature, empty deps, undefined sections', () => {
    const parsed = parseCutBody('')
    expect(parsed.feature).toBeNull()
    expect(parsed.dependsOn).toEqual([])
    expect(parsed.spec).toBeUndefined()
    expect(parsed.acceptance).toBeUndefined()
    expect(parsed.solid).toBeUndefined()
    expect(parsed.tests).toBeUndefined()
  })
})

describe('parseCutBody — missing **Feature**: line', () => {
  it('returns feature: null', () => {
    const body = `**Depends on**: #501

## Spec
build the thing
`
    const parsed = parseCutBody(body)
    expect(parsed.feature).toBeNull()
    expect(parsed.dependsOn).toEqual([501])
  })
})

// ---------------------------------------------------------------------------
// parseCutBody — **Depends on**: variants (Q3 lock tolerates several)
// ---------------------------------------------------------------------------

describe('parseCutBody — **Depends on**: variants', () => {
  it('parses `**Depends on**: none` as empty deps, no error', () => {
    const body = `**Feature**: foo
**Depends on**: none
`
    const parsed = parseCutBody(body)
    expect(parsed.dependsOn).toEqual([])
  })

  it('parses `**Depends on**:` with empty trailing as empty deps', () => {
    const body = `**Feature**: foo
**Depends on**:
`
    const parsed = parseCutBody(body)
    expect(parsed.dependsOn).toEqual([])
  })

  it('returns empty deps when the **Depends on**: line is missing (NOT an error)', () => {
    const body = `**Feature**: foo

## Spec
ok
`
    const parsed = parseCutBody(body)
    expect(parsed.dependsOn).toEqual([])
  })

  it('parses comma-space separated refs: #501, #502', () => {
    const body = `**Feature**: foo
**Depends on**: #501, #502
`
    const parsed = parseCutBody(body)
    expect(parsed.dependsOn).toEqual([501, 502])
  })

  it('parses space-separated refs: #501 #502', () => {
    const body = `**Feature**: foo
**Depends on**: #501 #502
`
    const parsed = parseCutBody(body)
    expect(parsed.dependsOn).toEqual([501, 502])
  })

  it('parses no-space refs: #501,#502', () => {
    const body = `**Feature**: foo
**Depends on**: #501,#502
`
    const parsed = parseCutBody(body)
    expect(parsed.dependsOn).toEqual([501, 502])
  })

  it('parses mixed-separator refs: #501, #502, #503,#504', () => {
    const body = `**Feature**: foo
**Depends on**: #501, #502, #503,#504
`
    const parsed = parseCutBody(body)
    expect(parsed.dependsOn).toEqual([501, 502, 503, 504])
  })
})

// ---------------------------------------------------------------------------
// parseCutBody — section parsing edge cases
// ---------------------------------------------------------------------------

describe('parseCutBody — section parsing', () => {
  it('matches headings case-insensitively (## spec → spec field)', () => {
    const body = `**Feature**: foo

## spec
lowercased heading
`
    const parsed = parseCutBody(body)
    expect(parsed.spec).toBeDefined()
    expect(parsed.spec).toContain('lowercased heading')
  })

  it('matches headings case-insensitively (## SPEC → spec field)', () => {
    const body = `**Feature**: foo

## SPEC
uppercased heading
`
    const parsed = parseCutBody(body)
    expect(parsed.spec).toBeDefined()
    expect(parsed.spec).toContain('uppercased heading')
  })

  it('trims leading and trailing whitespace from section bodies', () => {
    const body = `**Feature**: foo

## Spec


   body text


## Acceptance
acc
`
    const parsed = parseCutBody(body)
    expect(parsed.spec).toBe('body text')
  })

  it('captures ## SOLID into the solid field when present', () => {
    const body = `**Feature**: foo

## Spec
s

## SOLID
- SRP per module
- DIP via injected dispatcher

## Tests
- foo.test.ts
`
    const parsed = parseCutBody(body)
    expect(parsed.solid).toBeDefined()
    expect(parsed.solid).toContain('SRP per module')
    expect(parsed.solid).toContain('DIP via injected dispatcher')
  })

  it('leaves the solid field undefined when ## SOLID is absent', () => {
    const body = `**Feature**: foo

## Spec
s

## Acceptance
a

## Tests
t
`
    const parsed = parseCutBody(body)
    expect(parsed.solid).toBeUndefined()
  })

  it('ignores non-recognized H2 headings (## Notes does not appear in any field)', () => {
    const body = `**Feature**: foo

## Spec
s

## Notes
random aside the parser should ignore

## Tests
t
`
    const parsed = parseCutBody(body)
    expect(parsed.spec).toBe('s')
    expect(parsed.tests).toBe('t')
    // The "Notes" content does not leak into spec or tests.
    expect(parsed.spec).not.toContain('random aside')
    expect(parsed.tests).not.toContain('random aside')
    expect(parsed.solid).toBeUndefined()
    expect(parsed.acceptance).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// validateParsedCut — structural validation (NO GitHub queries)
// ---------------------------------------------------------------------------

function makeParsed(overrides: Partial<ParsedCut> = {}): ParsedCut {
  return {
    feature: 'foo',
    dependsOn: [],
    spec: 'spec body',
    acceptance: 'acceptance body',
    solid: 'solid body',
    tests: 'tests body',
    ...overrides,
  }
}

describe('validateParsedCut — missing feature', () => {
  it('emits a missing-feature error when feature is null', () => {
    const errors = validateParsedCut(makeParsed({ feature: null }))
    expect(errors).toContainEqual<ValidationError>({ kind: 'missing-feature' })
  })

  it('does NOT emit missing-feature when feature is present', () => {
    const errors = validateParsedCut(makeParsed({ feature: 'foo' }))
    expect(errors).not.toContainEqual<ValidationError>({ kind: 'missing-feature' })
  })
})

describe('validateParsedCut — required-section validation', () => {
  it('emits missing-required-section for absent spec', () => {
    const errors = validateParsedCut(makeParsed({ spec: undefined }))
    expect(errors).toContainEqual<ValidationError>({
      kind: 'missing-required-section',
      section: 'spec',
    })
  })

  it('emits missing-required-section for absent acceptance', () => {
    const errors = validateParsedCut(makeParsed({ acceptance: undefined }))
    expect(errors).toContainEqual<ValidationError>({
      kind: 'missing-required-section',
      section: 'acceptance',
    })
  })

  it('emits missing-required-section for absent tests', () => {
    const errors = validateParsedCut(makeParsed({ tests: undefined }))
    expect(errors).toContainEqual<ValidationError>({
      kind: 'missing-required-section',
      section: 'tests',
    })
  })

  it('does NOT emit an error when solid is absent (SOLID is conditional, not required)', () => {
    const errors = validateParsedCut(makeParsed({ solid: undefined }))
    expect(errors).not.toContainEqual<ValidationError>({
      kind: 'missing-required-section',
      section: 'solid' as never,
    })
    // Also: a happy parse with only solid missing should produce zero errors.
    expect(errors).toEqual([])
  })

  it('returns an empty error array when all required sections are present and feature is set', () => {
    const errors = validateParsedCut(makeParsed())
    expect(errors).toEqual([])
  })
})

describe('validateParsedCut — self-reference detection (Q3 lock)', () => {
  it('emits invalid-dep-ref / self-reference when ownIssueNumber matches a dep', () => {
    const parsed = makeParsed({ dependsOn: [501] })
    const errors = validateParsedCut(parsed, 501)
    expect(errors).toContainEqual<ValidationError>({
      kind: 'invalid-dep-ref',
      depNumber: 501,
      reason: 'self-reference',
    })
  })

  it('does NOT emit self-reference when ownIssueNumber differs from all deps', () => {
    const parsed = makeParsed({ dependsOn: [502] })
    const errors = validateParsedCut(parsed, 501)
    // No self-reference for #502 when own is #501.
    const selfRefErrors = errors.filter(e => e.kind === 'invalid-dep-ref' && e.reason === 'self-reference')
    expect(selfRefErrors).toEqual([])
  })

  it('does NOT emit self-reference when ownIssueNumber is undefined (caller did not thread it)', () => {
    const parsed = makeParsed({ dependsOn: [501] })
    const errors = validateParsedCut(parsed)
    const selfRefErrors = errors.filter(e => e.kind === 'invalid-dep-ref' && e.reason === 'self-reference')
    expect(selfRefErrors).toEqual([])
  })
})
