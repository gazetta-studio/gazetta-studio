import { describe, expect, it } from 'vitest'
import { checkLessonsDrift, computeCompactPhase, shouldPruneReviewerLog } from '../compact-decisions.js'

/**
 * Cover the four load-bearing gates the monthly compactor relies on
 * (compact.ts lines 111, 129, 173, 195). The decisions are pure so
 * they're tested here directly; compact.ts calls into these
 * functions after doing its own filesystem + env reads.
 *
 * Each non-trivial test carries a counterfactual comment naming a
 * plausible mutation that would fail it — the anti-tautology
 * discipline. A mutation testing pass over compact-decisions.ts
 * should find every branch's inversion caught by at least one test
 * here.
 */

const MIN_SKIP = 3
const MIN_LESSONS = 5

function phase(
  overrides: Partial<{
    skipListEntries: number
    reviewerLogEntries: number
    minEntriesForCompaction: number
    minReviewerLogForLessons: number
  }> = {},
) {
  return computeCompactPhase({
    skipListEntries: 0,
    reviewerLogEntries: 0,
    minEntriesForCompaction: MIN_SKIP,
    minReviewerLogForLessons: MIN_LESSONS,
    ...overrides,
  })
}

describe('computeCompactPhase (dead-code-watcher/compact.ts:108-116 gate)', () => {
  // Counterfactual: if `&&` in the both-below check flips to `||`, this
  // test still expects 'skip-both' but the function would return
  // 'lessons-only' (since 0 !>= 5 is true) or similar — test fails.
  it('returns skip-both-below-thresholds when neither surface has enough signal', () => {
    expect(phase({ skipListEntries: 0, reviewerLogEntries: 0 })).toBe('skip-both-below-thresholds')
    expect(phase({ skipListEntries: MIN_SKIP - 1, reviewerLogEntries: MIN_LESSONS - 1 })).toBe(
      'skip-both-below-thresholds',
    )
  })

  // Counterfactual: if the skip-list eligibility comparison flips
  // (e.g. `>` instead of `>=`), a surface at exactly its threshold
  // becomes ineligible and 'skip-list-only' regresses to
  // 'skip-both-below-thresholds' — test fails. The boundary matters
  // because the docstring's contract is "as soon as the minimum
  // signal accumulates," not "one more than the minimum."
  it('treats exactly-at-threshold as eligible (>=, not >)', () => {
    expect(phase({ skipListEntries: MIN_SKIP, reviewerLogEntries: 0 })).toBe('skip-list-only')
    expect(phase({ skipListEntries: 0, reviewerLogEntries: MIN_LESSONS })).toBe('lessons-only')
    expect(phase({ skipListEntries: MIN_SKIP, reviewerLogEntries: MIN_LESSONS })).toBe('both')
  })

  it('returns skip-list-only when only skip-list clears its threshold', () => {
    expect(phase({ skipListEntries: 10, reviewerLogEntries: 0 })).toBe('skip-list-only')
    expect(phase({ skipListEntries: 10, reviewerLogEntries: MIN_LESSONS - 1 })).toBe('skip-list-only')
  })

  it('returns lessons-only when only reviewer-log clears its threshold', () => {
    expect(phase({ skipListEntries: 0, reviewerLogEntries: 100 })).toBe('lessons-only')
    expect(phase({ skipListEntries: MIN_SKIP - 1, reviewerLogEntries: 100 })).toBe('lessons-only')
  })

  it('returns both when both surfaces clear their thresholds', () => {
    expect(phase({ skipListEntries: 10, reviewerLogEntries: 100 })).toBe('both')
  })

  // Counterfactual: if the skip-list and lessons eligibility computations
  // got accidentally swapped (a real refactor risk when both are
  // structurally identical), this test would catch it — the input has
  // enough for one surface only, and the returned phase names which.
  it.each([
    { name: 'skip-list only', skipListEntries: MIN_SKIP + 5, reviewerLogEntries: 0, expected: 'skip-list-only' },
    { name: 'lessons only', skipListEntries: 0, reviewerLogEntries: MIN_LESSONS + 5, expected: 'lessons-only' },
  ])('routes eligibility to the correct surface ($name)', ({ skipListEntries, reviewerLogEntries, expected }) => {
    expect(phase({ skipListEntries, reviewerLogEntries })).toBe(expected)
  })

  it('honors caller-supplied thresholds (not hardcoded constants)', () => {
    // Passing a very high threshold overrides the defaults — proves the
    // function actually consults the input rather than hardcoded 3/5.
    // Counterfactual: if the function ignored min* args and used
    // hardcoded 3/5, this test would still see 'both' (since 100 >= 3
    // and 100 >= 5).
    expect(
      computeCompactPhase({
        skipListEntries: 100,
        reviewerLogEntries: 100,
        minEntriesForCompaction: 1000,
        minReviewerLogForLessons: 1000,
      }),
    ).toBe('skip-both-below-thresholds')
  })
})

describe('shouldPruneReviewerLog (dead-code-watcher/compact.ts:195-205 gate)', () => {
  // Counterfactual: if the function returns `!claudeSucceeded`, both
  // tests fail. If it always returns true, the failure-case fails
  // (would prune on a failed run and lose next month's retry input —
  // the exact bug the "Claude did not succeed" branch was written to
  // prevent). If it always returns false, the success-case fails
  // (log grows unbounded).
  it('prunes on Claude success', () => {
    expect(shouldPruneReviewerLog(true)).toBe(true)
  })

  it('preserves the log on Claude failure (retry-input invariant)', () => {
    expect(shouldPruneReviewerLog(false)).toBe(false)
  })
})

// Fixture reused from tests/signal-count-guard.test.ts (the #686 drift
// the compactor's exit-code-1 path was written to catch). Deliberate
// duplication: the shape here pins the compact-decisions.ts contract,
// not the signal-count-guard.ts contract, so the two tests must
// survive independently.
const DRIFTING_LESSONS = `## 1. Un-export beats delete

**Signal:** 14 first-attempt approves across 6 runs, by shape:

- Internal type reference (6): \`HreflangAlternate\`, \`SvgSanitizeWarning\`
- Default parameter fallback (3): \`ANTHROPIC_DEFAULT_MODEL\`
- Formula/expression use (2): \`CHARS_PER_TOKEN\`, \`MIN_MAX_TOKENS\`
- Sister-function dispatch (1): \`resolveEmbeddedRef\`
- Internal helper class (1): \`AssetApiError\`
`

const CLEAN_LESSONS = `## 1. Un-export beats delete

**Signal:** 13 first-attempt approves across 6 runs, by shape:

- Internal type reference (6): \`a\`, \`b\`
- Default parameter fallback (3): \`c\`
- Formula/expression use (2): \`d\`, \`e\`
- Sister-function dispatch (1): \`f\`
- Internal helper class (1): \`g\`
`

describe('checkLessonsDrift (dead-code-watcher/compact.ts:173-187 gate)', () => {
  // Counterfactual: if the `claudeSucceeded` gate were removed and the
  // function always ran findSignalCountViolations, this test would
  // fail — it would surface violations for content the current run
  // isn't responsible for authoring. The gate is load-bearing because
  // compact.ts's `existsSync(LESSONS_ABS) ? readFileSync(...) : ''`
  // reads a file that may contain drift from an earlier month, and
  // failing the current run for that would be a false positive.
  it('never reports drift when Claude did not succeed (even if the file drifts)', () => {
    const result = checkLessonsDrift({ claudeSucceeded: false, lessonsContent: DRIFTING_LESSONS })
    expect(result.fail).toBe(false)
    expect(result.violations).toEqual([])
  })

  it('reports no drift when Claude succeeded and the file is clean', () => {
    const result = checkLessonsDrift({ claudeSucceeded: true, lessonsContent: CLEAN_LESSONS })
    expect(result.fail).toBe(false)
    expect(result.violations).toEqual([])
  })

  it('reports no drift when Claude succeeded and the file is empty (no Signal headers)', () => {
    const result = checkLessonsDrift({ claudeSucceeded: true, lessonsContent: '' })
    expect(result.fail).toBe(false)
    expect(result.violations).toEqual([])
  })

  // Counterfactual: if the fail predicate flipped (`violations.length === 0`),
  // this test would report `fail: false` — hiding the drift the compactor
  // was written to catch. This is the highest-priority behavior per the
  // candidate summary; the #686 drift shipped exactly because there was
  // no test pinning "drift → fail."
  it('reports fail=true with the offending violation(s) when Claude wrote a drifting file', () => {
    const result = checkLessonsDrift({ claudeSucceeded: true, lessonsContent: DRIFTING_LESSONS })
    expect(result.fail).toBe(true)
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]).toMatchObject({ header: 14, sum: 13 })
    // Preserve the offending line so compact.ts can surface it in the
    // warning message — a refactor that drops this field silently
    // regresses the printWarning output at compact.ts:178.
    expect(result.violations[0].line).toContain('**Signal:** 14')
  })

  it('surfaces every drifting header independently (not just the first)', () => {
    const md = `## 1. First

**Signal:** 10 approves, by shape:

- Shape A (4): x
- Shape B (3): y

## 2. Second

**Signal:** 5 approves, by shape:

- Shape C (2): z
- Shape D (2): w
`
    const result = checkLessonsDrift({ claudeSucceeded: true, lessonsContent: md })
    expect(result.fail).toBe(true)
    expect(result.violations).toHaveLength(2)
    expect(result.violations.map(v => ({ header: v.header, sum: v.sum }))).toEqual([
      { header: 10, sum: 7 },
      { header: 5, sum: 4 },
    ])
  })
})
