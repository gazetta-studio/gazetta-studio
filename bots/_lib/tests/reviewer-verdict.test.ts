import { describe, expect, it } from 'vitest'
import { parseReviewerVerdict } from '../reviewer-verdict.js'

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
})
