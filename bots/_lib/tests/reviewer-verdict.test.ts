import { describe, expect, it } from 'vitest'
import { parseReviewerTranscript, parseReviewerVerdict } from '../reviewer-verdict.js'

describe('parseReviewerVerdict', () => {
  it('parses APPROVE with following Reasoning', () => {
    const text = `Looking at the diff...

VERDICT: APPROVE
Reasoning: The deletion is safe. No dynamic-load patterns reference this file.`
    const verdict = parseReviewerVerdict(text)
    expect(verdict.kind).toBe('approve')
    if (verdict.kind === 'approve') {
      expect(verdict.reasoning).toContain('deletion is safe')
    }
  })

  it('parses APPROVE without Reasoning keyword', () => {
    const verdict = parseReviewerVerdict('VERDICT: APPROVE\nLooks good.')
    expect(verdict.kind).toBe('approve')
    if (verdict.kind === 'approve') {
      expect(verdict.reasoning).toBe('Looks good.')
    }
  })

  it('parses REJECT with Note', () => {
    const text = `VERDICT: REJECT
Note: The function on line 42 is dynamically loaded by the template registry.`
    const verdict = parseReviewerVerdict(text)
    expect(verdict.kind).toBe('reject')
    if (verdict.kind === 'reject') {
      expect(verdict.note).toContain('dynamically loaded')
    }
  })

  it('REJECT without Note defaults to needs-human (cannot retry without feedback)', () => {
    const verdict = parseReviewerVerdict('VERDICT: REJECT')
    expect(verdict.kind).toBe('needs-human')
    if (verdict.kind === 'needs-human') {
      expect(verdict.note).toContain('no Note: explanation')
    }
  })

  it('parses NEEDS_HUMAN with Note', () => {
    const text = `VERDICT: NEEDS_HUMAN
Note: This is a public API marked @internal but exposed in @types/...`
    const verdict = parseReviewerVerdict(text)
    expect(verdict.kind).toBe('needs-human')
    if (verdict.kind === 'needs-human') {
      expect(verdict.note).toContain('public API')
    }
  })

  it('returns needs-human when VERDICT line is missing', () => {
    const verdict = parseReviewerVerdict('I think this looks fine.')
    expect(verdict.kind).toBe('needs-human')
    if (verdict.kind === 'needs-human') {
      expect(verdict.note).toContain('did not contain a recognizable')
    }
  })

  it('returns needs-human when VERDICT keyword is invalid', () => {
    const verdict = parseReviewerVerdict('VERDICT: YOLO')
    expect(verdict.kind).toBe('needs-human')
  })

  it('accepts leading whitespace before VERDICT', () => {
    const verdict = parseReviewerVerdict('Some preamble\n   VERDICT: APPROVE\nReasoning: fine')
    expect(verdict.kind).toBe('approve')
  })

  it('truncates very long notes to 2000 chars', () => {
    const longNote = 'x'.repeat(3000)
    const text = `VERDICT: REJECT\nNote: ${longNote}`
    const verdict = parseReviewerVerdict(text)
    if (verdict.kind === 'reject') {
      expect(verdict.note.length).toBeLessThanOrEqual(2000)
    }
  })

  it('tolerates VERDICT with extra trailing whitespace', () => {
    const verdict = parseReviewerVerdict('VERDICT: APPROVE   \nReasoning: ok')
    expect(verdict.kind).toBe('approve')
  })

  describe('last-occurrence semantics', () => {
    it('takes the LAST VERDICT line when multiple are present', () => {
      // Reviewer thinks out loud: "Initial thought: REJECT? Actually: APPROVE."
      const text = `Initial scan suggested:

VERDICT: REJECT
Note: Not yet convinced.

After reading the test:

VERDICT: APPROVE
Reasoning: The test does pin the contract — reverting breaks it.`
      const verdict = parseReviewerVerdict(text)
      expect(verdict.kind).toBe('approve')
      if (verdict.kind === 'approve') expect(verdict.reasoning).toMatch(/test does pin/)
    })

    it('a final VERDICT overrides an earlier soft signal', () => {
      const text = `> Decision: reject

After re-reading:

VERDICT: APPROVE
Reasoning: I missed the fix-extracting-helper pattern.`
      const verdict = parseReviewerVerdict(text)
      expect(verdict.kind).toBe('approve')
    })
  })

  describe('soft-signal fallback', () => {
    it('accepts `> Decision: approve` when no VERDICT line is present', () => {
      const text = `Looking at the diff, the assertion pins the contract.

> Decision: approve — the test fails when the fix is reverted.`
      const verdict = parseReviewerVerdict(text)
      expect(verdict.kind).toBe('approve')
    })

    it('accepts `Recommendation: REJECT` with a note', () => {
      const text = `The fix targets the wrong function.

Recommendation: REJECT — should patch publish.ts:182, not the caller.`
      const verdict = parseReviewerVerdict(text)
      expect(verdict.kind).toBe('reject')
      if (verdict.kind === 'reject') expect(verdict.note).toMatch(/publish\.ts:182/)
    })

    it('accepts `Verdict: needs_human` (underscore variant)', () => {
      const text = `Verdict: needs_human — design intent unclear.`
      const verdict = parseReviewerVerdict(text)
      expect(verdict.kind).toBe('needs-human')
    })

    it('soft REJECT without note → needs-human (cannot retry without feedback)', () => {
      const verdict = parseReviewerVerdict('> Decision: reject')
      expect(verdict.kind).toBe('needs-human')
    })

    it('still defaults to needs-human when neither hard nor soft signal exists', () => {
      const verdict = parseReviewerVerdict('I have been reading the diff and design docs. Forming verdict.')
      expect(verdict.kind).toBe('needs-human')
      if (verdict.kind === 'needs-human') expect(verdict.note).toMatch(/did not contain/)
    })
  })
})

describe('parseReviewerTranscript', () => {
  it('finds VERDICT line in earlier message when last block is a meta-comment', () => {
    // The May 23 #414 / #415 failure mode: VERDICT in earlier block,
    // last block was "Forming verdict." or similar.
    const blocks = [
      `Reviewing the diff for #414…

Step 1 passes: revert + test = the test still fails as expected.
Step 2 passes: the test pins the contract.

VERDICT: APPROVE
Reasoning: 17 of 21 tests fail when the fix is reverted. The fix is in the right call chain.`,
      `Multiple design docs were autoloaded by the system; I have full context. Forming verdict.`,
    ]
    const verdict = parseReviewerTranscript(blocks)
    expect(verdict.kind).toBe('approve')
    if (verdict.kind === 'approve') expect(verdict.reasoning).toMatch(/17 of 21/)
  })

  it('uses soft signal across blocks when no VERDICT line exists', () => {
    const blocks = [
      `Let me check the test isolation per rule 26.`,
      `Tests use fresh memoryStorage() — good.

> Decision: approve. Tests are isolated and pin the contract.`,
    ]
    const verdict = parseReviewerTranscript(blocks)
    expect(verdict.kind).toBe('approve')
  })

  it('returns needs-human for empty input', () => {
    const verdict = parseReviewerTranscript([])
    expect(verdict.kind).toBe('needs-human')
  })
})
