import { describe, expect, it } from 'vitest'
import { parseCommentRequest } from '../review-comment-grammar.js'

// Tests derived from design-code-review.md grammar (locked at Q-comment-trigger).

describe('parseCommentRequest — locked grammar from design-code-review.md', () => {
  it('@claude review (no args) returns review-all', () => {
    const r = parseCommentRequest('@claude review')
    expect(r.kind).toBe('review-all')
  })

  it('@claude review (with leading whitespace) returns review-all', () => {
    const r = parseCommentRequest('  @claude review')
    expect(r.kind).toBe('review-all')
  })

  it('@claude review with one short-form angle returns review-angles', () => {
    const r = parseCommentRequest('@claude review security')
    expect(r.kind).toBe('review-angles')
    if (r.kind === 'review-angles') expect(r.angles).toEqual(['review-security'])
  })

  it('@claude review with multiple short-form angles', () => {
    const r = parseCommentRequest('@claude review security tests architecture')
    expect(r.kind).toBe('review-angles')
    if (r.kind === 'review-angles') {
      expect(r.angles).toContain('review-security')
      expect(r.angles).toContain('review-tests')
      expect(r.angles).toContain('review-architecture')
    }
  })

  it('@claude review with long-form angle (review-X) accepted', () => {
    const r = parseCommentRequest('@claude review review-security')
    expect(r.kind).toBe('review-angles')
    if (r.kind === 'review-angles') expect(r.angles).toEqual(['review-security'])
  })

  it('@claude review with unknown angle returns unrecognized', () => {
    const r = parseCommentRequest('@claude review banana')
    expect(r.kind).toBe('unrecognized')
    if (r.kind === 'unrecognized') {
      expect(r.reason).toContain('banana')
      expect(r.reason).toContain('Valid')
    }
  })

  it('@claude review with mix of known + unknown rejects entire request', () => {
    const r = parseCommentRequest('@claude review security banana')
    expect(r.kind).toBe('unrecognized')
    if (r.kind === 'unrecognized') {
      expect(r.reason).toContain('banana')
    }
  })

  it('@claude audit <path> returns audit', () => {
    const r = parseCommentRequest('@claude audit packages/gazetta/src/auth/')
    expect(r.kind).toBe('audit')
    if (r.kind === 'audit') expect(r.path).toBe('packages/gazetta/src/auth/')
  })

  it('@claude audit without path returns unrecognized', () => {
    const r = parseCommentRequest('@claude audit')
    expect(r.kind).toBe('unrecognized')
  })

  it('plain text with no trigger returns unrecognized', () => {
    const r = parseCommentRequest('LGTM, thanks!')
    expect(r.kind).toBe('unrecognized')
  })

  it('PR description mentioning @claude review in prose does NOT fire (must be at line start)', () => {
    const r = parseCommentRequest('I asked the bot to "@claude review" earlier, but it ignored me.')
    expect(r.kind).toBe('unrecognized')
  })

  it('trigger on a separate line within a longer comment fires', () => {
    const body = 'Initial thoughts on this PR:\n@claude review security\nThanks!'
    const r = parseCommentRequest(body)
    expect(r.kind).toBe('review-angles')
    if (r.kind === 'review-angles') expect(r.angles).toEqual(['review-security'])
  })

  it('case-insensitive trigger word (defensive)', () => {
    const r = parseCommentRequest('@Claude REVIEW security')
    expect(r.kind).toBe('review-angles')
  })

  it('trigger with trailing whitespace', () => {
    const r = parseCommentRequest('@claude review   ')
    expect(r.kind).toBe('review-all')
  })

  it('audit with absolute-style path returns audit', () => {
    const r = parseCommentRequest('@claude audit /packages/gazetta/src/auth/')
    expect(r.kind).toBe('audit')
    if (r.kind === 'audit') expect(r.path).toBe('/packages/gazetta/src/auth/')
  })

  it('multiple triggers — first one wins (defensive against accidental duplication)', () => {
    const body = '@claude audit packages/auth/\n@claude review security'
    const r = parseCommentRequest(body)
    expect(r.kind).toBe('audit')
  })
})
