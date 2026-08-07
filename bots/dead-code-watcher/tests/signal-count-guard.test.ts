import { describe, expect, it } from 'vitest'
import { findSignalCountViolations } from '../signal-count-guard.js'

/**
 * Guards against the #686→#688 compaction drift: an LLM-authored
 * `**Signal:** N ...` header whose per-shape sub-tallies do not sum
 * to N. The compactor lets Claude write lessons-learned.md directly,
 * so this is a deterministic POST-generation gate — a mismatch fails
 * the compaction run before the PR opens.
 *
 * A "sub-tally" is a bullet of the shape `- <label> (K): ...` under a
 * Signal header. When a header has NO sub-tally bullets, there is
 * nothing to cross-check and the header is left alone (a lone count is
 * out of this guard's scope — see design-self-learning.md Y-now-X-later).
 */
describe('findSignalCountViolations', () => {
  it('flags the exact #686 drift: header 14 vs sub-tallies summing to 13', () => {
    const md = `## 1. Un-export beats delete

**Signal:** 14 first-attempt approves across 6 runs, by shape:

- Internal type reference (6): \`HreflangAlternate\`, \`SvgSanitizeWarning\`
- Default parameter fallback (3): \`ANTHROPIC_DEFAULT_MODEL\`
- Formula/expression use (2): \`CHARS_PER_TOKEN\`, \`MIN_MAX_TOKENS\`
- Sister-function dispatch (1): \`resolveEmbeddedRef\`
- Internal helper class (1): \`AssetApiError\`
`
    const violations = findSignalCountViolations(md)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ header: 14, sum: 13 })
  })

  it('accepts a header whose sub-tallies sum correctly (the #688 fix state)', () => {
    const md = `## 1. Un-export beats delete

**Signal:** 13 first-attempt approves across 6 runs, by shape:

- Internal type reference (6): \`a\`, \`b\`
- Default parameter fallback (3): \`c\`
- Formula/expression use (2): \`d\`, \`e\`
- Sister-function dispatch (1): \`f\`
- Internal helper class (1): \`g\`
`
    expect(findSignalCountViolations(md)).toHaveLength(0)
  })

  it('leaves a lone Signal count (no sub-tallies) alone — out of scope', () => {
    const md = `## 2. Verify both public-surface paths

**Signal:** cited in every approval across the current log window.

**Guidance:** a symbol is public if EITHER ...
`
    expect(findSignalCountViolations(md)).toHaveLength(0)
  })

  it('handles a Signal count with a plain number but no "by shape" sub-tallies', () => {
    const md = `## 3. Barrel re-exports are dead

**Signal:** 6 approvals — \`SharpAdapterOptions\`, \`CloudflareAdapterOptions\`;
\`AIAdapterFailedError\`, \`AIAdapterUnavailableError\`.

**Guidance:** trace where consumers import from.
`
    // Inline comma-list is prose, not `- label (K):` sub-tally bullets → no cross-check.
    expect(findSignalCountViolations(md)).toHaveLength(0)
  })

  it('flags each drifting header independently across multiple lessons', () => {
    const md = `## 1. First

**Signal:** 10 approves, by shape:

- Shape A (4): x
- Shape B (3): y

## 2. Second

**Signal:** 5 approves, by shape:

- Shape C (2): z
- Shape D (2): w
`
    const violations = findSignalCountViolations(md)
    // #1: header 10 vs 4+3=7 → violation; #2: header 5 vs 2+2=4 → violation
    expect(violations).toHaveLength(2)
    expect(violations.map(v => ({ header: v.header, sum: v.sum }))).toEqual([
      { header: 10, sum: 7 },
      { header: 5, sum: 4 },
    ])
  })

  it('returns empty for a lessons file with no Signal headers', () => {
    expect(findSignalCountViolations('# lessons\n\nSome prose.\n')).toHaveLength(0)
  })

  // Edge cases from the runtime sweep: Claude authors this file freely,
  // so the guard must tolerate plausible LLM formatting variants — a
  // false-clean (drift ships) is the worst failure mode for a gate.

  it('catches drift under a leading-whitespace-indented Signal header', () => {
    const md = `  **Signal:** 9 across 6 runs, by shape:

  - Internal type reference (2): \`a\`, \`b\`
  - Default parameter fallback (3): \`c\`
`
    const v = findSignalCountViolations(md)
    expect(v).toHaveLength(1)
    expect(v[0]).toMatchObject({ header: 9, sum: 5 })
  })

  it('catches drift when sub-tallies use `*` bullets instead of `-`', () => {
    const md = `**Signal:** 9 by shape:

* Shape A (2): x
* Shape B (3): y
`
    const v = findSignalCountViolations(md)
    expect(v).toHaveLength(1)
    expect(v[0]).toMatchObject({ header: 9, sum: 5 })
  })

  it('accepts a consistent header+tallies with `*` bullets and indentation', () => {
    const md = `  **Signal:** 5 by shape:

  * Shape A (2): x
  * Shape B (3): y
`
    expect(findSignalCountViolations(md)).toHaveLength(0)
  })
})
