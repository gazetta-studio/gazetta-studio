import { describe, expect, it } from 'vitest'
import { type Candidate, extractCandidatesFence, parseCandidatesFence, rankCandidates } from '../candidates.js'

const cand = (overrides: Partial<Candidate> = {}): Candidate => ({
  area: 'packages/gazetta/src/auth/',
  type: 'security',
  severity: 'IMPORTANT',
  summary: 'capability check missing',
  suggested_action: 'add requireCapability middleware',
  confidence: 85,
  rule: 'design-auth-rbac.md',
  ...overrides,
})

describe('extractCandidatesFence', () => {
  it('extracts JSONL body from a candidates fence', () => {
    const text =
      'Prose.\n\n```candidates\n{"area":"a/","type":"security","severity":"CRITICAL","summary":"x","confidence":92}\n```\nMore prose.'
    expect(extractCandidatesFence(text)).toBe(
      '{"area":"a/","type":"security","severity":"CRITICAL","summary":"x","confidence":92}',
    )
  })

  it('returns empty string when no fence present', () => {
    expect(extractCandidatesFence('no fence here')).toBe('')
  })

  it('does NOT pick up a findings fence (different label)', () => {
    const text = '```findings\n{"severity":"CRITICAL"}\n```'
    expect(extractCandidatesFence(text)).toBe('')
  })
})

describe('parseCandidatesFence', () => {
  it('parses a well-formed candidate', () => {
    const body =
      '{"area":"packages/gazetta/src/auth/","type":"security","severity":"IMPORTANT","summary":"x","suggested_action":"y","confidence":85,"rule":"design-auth-rbac.md"}'
    const parsed = parseCandidatesFence(body)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.type).toBe('security')
  })

  it('rejects unknown type', () => {
    const body = '{"area":"a/","type":"bogus","severity":"CRITICAL","summary":"x","confidence":85}'
    expect(parseCandidatesFence(body)).toEqual([])
  })

  it('rejects unknown severity', () => {
    const body = '{"area":"a/","type":"security","severity":"WHATEVER","summary":"x","confidence":85}'
    expect(parseCandidatesFence(body)).toEqual([])
  })

  it('rejects missing area or summary or confidence', () => {
    const cases = [
      '{"type":"security","severity":"CRITICAL","summary":"x","confidence":85}', // missing area
      '{"area":"a/","type":"security","severity":"CRITICAL","confidence":85}', // missing summary
      '{"area":"a/","type":"security","severity":"CRITICAL","summary":"x"}', // missing confidence
    ]
    for (const body of cases) {
      expect(parseCandidatesFence(body)).toEqual([])
    }
  })

  it('skips malformed JSON lines', () => {
    const body = 'not-json\n{"area":"a/","type":"tests","severity":"NIT","summary":"x","confidence":80}'
    expect(parseCandidatesFence(body)).toHaveLength(1)
  })

  it('fills in defaults for suggested_action + rule when absent', () => {
    const body = '{"area":"a/","type":"tests","severity":"NIT","summary":"x","confidence":80}'
    const parsed = parseCandidatesFence(body)
    expect(parsed[0]).toMatchObject({ suggested_action: '', rule: '' })
  })
})

describe('rankCandidates', () => {
  it('sorts CRITICAL > IMPORTANT > NIT', () => {
    const cs = [cand({ severity: 'NIT' }), cand({ severity: 'CRITICAL' }), cand({ severity: 'IMPORTANT' })]
    const ranked = rankCandidates(cs)
    expect(ranked.map(c => c.severity)).toEqual(['CRITICAL', 'IMPORTANT', 'NIT'])
  })

  it('within same severity, higher confidence wins', () => {
    const cs = [cand({ severity: 'IMPORTANT', confidence: 80 }), cand({ severity: 'IMPORTANT', confidence: 92 })]
    const ranked = rankCandidates(cs)
    expect(ranked[0]?.confidence).toBe(92)
    expect(ranked[1]?.confidence).toBe(80)
  })

  it('drops confidence < 80 (defensive)', () => {
    const cs = [cand({ confidence: 75 }), cand({ confidence: 85 })]
    expect(rankCandidates(cs)).toHaveLength(1)
  })

  it('applies skip-list predicate as final filter', () => {
    const cs = [cand({ severity: 'CRITICAL', area: 'skipped/' }), cand({ severity: 'IMPORTANT', area: 'kept/' })]
    const ranked = rankCandidates(cs, c => c.area === 'skipped/')
    expect(ranked).toHaveLength(1)
    expect(ranked[0]?.area).toBe('kept/')
  })

  it('returns empty array when all candidates are skipped or low-confidence', () => {
    const cs = [cand({ confidence: 70 }), cand({ confidence: 50 })]
    expect(rankCandidates(cs)).toEqual([])
  })
})
