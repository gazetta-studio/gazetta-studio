import { describe, expect, it } from 'vitest'
import {
  applyActionPolicy,
  extractFindingsFence,
  parseFindingsFence,
  type SkillFinding,
} from '../verdict.js'

const finding = (overrides: Partial<SkillFinding> = {}): SkillFinding => ({
  severity: 'IMPORTANT',
  file: 'packages/gazetta/src/foo.ts',
  line: 42,
  confidence: 85,
  category: 'correctness',
  rule: 'team-preferences.md#15',
  message: 'something',
  suggestion: 'fix it',
  ...overrides,
})

describe('extractFindingsFence', () => {
  it('extracts JSONL body from a findings fence', () => {
    const text =
      'Some prose first.\n\n```findings\n{"severity":"CRITICAL","file":"a.ts","line":1,"confidence":92}\n{"severity":"NIT","file":"b.ts","line":2,"confidence":80}\n```\n\nMore prose.'
    expect(extractFindingsFence(text)).toBe(
      '{"severity":"CRITICAL","file":"a.ts","line":1,"confidence":92}\n{"severity":"NIT","file":"b.ts","line":2,"confidence":80}',
    )
  })

  it('returns empty string when no fence present', () => {
    expect(extractFindingsFence('no fence here, just prose')).toBe('')
  })

  it('extracts an empty fence (no findings emitted)', () => {
    expect(extractFindingsFence('prose\n\n```findings\n\n```\nmore prose')).toBe('')
  })
})

describe('parseFindingsFence', () => {
  it('parses well-formed JSONL', () => {
    const body = '{"severity":"CRITICAL","file":"a.ts","line":1,"confidence":92,"category":"security","rule":"design-auth.md","message":"x","suggestion":"y"}'
    const parsed = parseFindingsFence(body)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.severity).toBe('CRITICAL')
  })

  it('skips malformed lines without crashing', () => {
    const body = '{"severity":"CRITICAL","file":"a.ts","line":1,"confidence":92}\nnot-json\n{"severity":"NIT","file":"b.ts","line":2,"confidence":80}'
    expect(parseFindingsFence(body)).toHaveLength(2)
  })

  it('skips lines missing required fields', () => {
    const body = '{"severity":"CRITICAL"}\n{"file":"a.ts","line":1}\n{"severity":"NIT","file":"a.ts","line":1,"confidence":80}'
    expect(parseFindingsFence(body)).toHaveLength(1)
  })

  it('rejects unknown severity values (defensive)', () => {
    const body = '{"severity":"BOGUS","file":"a.ts","line":1,"confidence":92}'
    expect(parseFindingsFence(body)).toHaveLength(0)
  })

  it('empty body returns empty array', () => {
    expect(parseFindingsFence('')).toEqual([])
  })

  it('fills in default category/rule/message/suggestion when omitted', () => {
    const body = '{"severity":"NIT","file":"a.ts","line":1,"confidence":80}'
    const parsed = parseFindingsFence(body)
    expect(parsed[0]).toMatchObject({
      severity: 'NIT',
      category: 'correctness',
      rule: '',
      message: '',
      suggestion: '',
    })
  })
})

describe('applyActionPolicy — locked from design-code-review.md action-policy table', () => {
  it('no findings → APPROVE', () => {
    const v = applyActionPolicy([])
    expect(v.kind).toBe('approve')
  })

  it('only NIT findings → APPROVE', () => {
    const v = applyActionPolicy([finding({ severity: 'NIT' })])
    expect(v.kind).toBe('approve')
    if (v.kind === 'approve') expect(v.reasoning).toContain('1 NIT')
  })

  it('only IMPORTANT findings → REJECT (retry-feasible)', () => {
    const v = applyActionPolicy([finding({ severity: 'IMPORTANT' })])
    expect(v.kind).toBe('reject')
    if (v.kind === 'reject') {
      expect(v.note).toContain('[IMPORTANT]')
      expect(v.note).toContain('something')
      expect(v.findings).toHaveLength(1)
    }
  })

  it('CRITICAL with non-design rule → REJECT (Agent A can retry)', () => {
    const v = applyActionPolicy([
      finding({ severity: 'CRITICAL', rule: 'team-preferences.md#15' }),
    ])
    expect(v.kind).toBe('reject')
    if (v.kind === 'reject') expect(v.note).toContain('[CRITICAL]')
  })

  it('CRITICAL with design-doc rule → NEEDS_HUMAN (likely needs redesign)', () => {
    const v = applyActionPolicy([
      finding({ severity: 'CRITICAL', rule: 'design-auth-rbac.md#capability-gate' }),
    ])
    expect(v.kind).toBe('needs-human')
    if (v.kind === 'needs-human') {
      expect(v.note).toContain('[CRITICAL]')
      expect(v.note).toContain('design-auth-rbac.md')
    }
  })

  it('mix of CRITICAL + IMPORTANT → CRITICAL wins (REJECT or NEEDS_HUMAN)', () => {
    const v = applyActionPolicy([
      finding({ severity: 'IMPORTANT' }),
      finding({ severity: 'CRITICAL', rule: 'team-preferences.md#15' }),
    ])
    expect(v.kind).toBe('reject')
    if (v.kind === 'reject') {
      // Note should include the CRITICAL first, then IMPORTANT
      const criticalIdx = v.note.indexOf('[CRITICAL]')
      const importantIdx = v.note.indexOf('[IMPORTANT]')
      expect(criticalIdx).toBeGreaterThanOrEqual(0)
      expect(importantIdx).toBeGreaterThan(criticalIdx)
    }
  })
})
