import { describe, expect, it } from 'vitest'
import { parseBotPRs, parseGitLogTouches, parsePickerOutput } from '../phase0-collect.js'
import { fingerprintToBranch } from '../past-pr.js'
import type { Fingerprint } from '../skip-list.js'

describe('parseGitLogTouches', () => {
  it('parses one commit with multiple files', () => {
    const out = 'COMMIT 2026-05-17T10:00:00+00:00\npackages/gazetta/src/foo.ts\npackages/gazetta/src/bar.ts'
    const touches = parseGitLogTouches(out)
    expect(touches).toEqual([
      { path: 'packages/gazetta/src/foo.ts', lastTouchedAt: '2026-05-17T10:00:00+00:00' },
      { path: 'packages/gazetta/src/bar.ts', lastTouchedAt: '2026-05-17T10:00:00+00:00' },
    ])
  })

  it('keeps only the most-recent timestamp for a file touched in multiple commits', () => {
    // git log emits newest-first, so the FIRST occurrence is the most recent.
    const out = [
      'COMMIT 2026-05-17T10:00:00+00:00',
      'packages/gazetta/src/foo.ts',
      'COMMIT 2026-05-10T08:00:00+00:00',
      'packages/gazetta/src/foo.ts',
      'packages/gazetta/src/older.ts',
    ].join('\n')
    const touches = parseGitLogTouches(out)
    expect(touches).toHaveLength(2)
    const foo = touches.find(t => t.path === 'packages/gazetta/src/foo.ts')
    expect(foo?.lastTouchedAt).toBe('2026-05-17T10:00:00+00:00')
  })

  it('skips blank lines + handles empty input', () => {
    expect(parseGitLogTouches('')).toEqual([])
    expect(parseGitLogTouches('\n\n')).toEqual([])
  })

  it('skips files emitted before any COMMIT marker (defensive)', () => {
    const out = 'orphan-file.ts\nCOMMIT 2026-05-17T10:00:00+00:00\nreal-file.ts'
    const touches = parseGitLogTouches(out)
    // Orphan-file is recorded with empty timestamp; we don't filter it
    // out because that's the producer's job, but the parser must
    // remain robust. The IMPORTANT invariant: real-file is captured.
    expect(touches.some(t => t.path === 'real-file.ts')).toBe(true)
  })
})

describe('parseBotPRs', () => {
  it('groups by area-path from headRefName (round-trips fingerprintToBranch)', () => {
    // The Map's key must match the originating Fingerprint.area so
    // scoreAreas can look up daysSinceBotTouched by area path.
    // Synthetic branch shapes like `improve/auth-cap-gate-92` were the
    // bug's hiding place — they made the test pass while the production
    // signal (which uses fingerprintToBranch-encoded branches) was dead.
    const stdout = JSON.stringify([
      {
        headRefName: fingerprintToBranch({
          area: 'packages/gazetta/src/auth/',
          type: 'security',
          rule: 'design-auth-rbac.md#capability-gate',
        }),
        createdAt: '2026-05-15T10:00:00Z',
      },
      {
        headRefName: fingerprintToBranch({
          area: 'packages/gazetta/src/auth/',
          type: 'security',
          rule: 'design-auth-rbac.md#rbac-bypass',
        }),
        createdAt: '2026-05-17T10:00:00Z',
      },
      {
        headRefName: fingerprintToBranch({
          area: 'apps/admin/src/',
          type: 'tests',
          rule: 'testing-plan.md#trophy',
        }),
        createdAt: '2026-05-16T10:00:00Z',
      },
    ])
    const result = parseBotPRs(stdout, 180)
    // Keyed by area path with trailing slash — what scoreAreas looks up.
    expect(result.get('packages/gazetta/src/auth/')).toBe('2026-05-17T10:00:00Z')
    expect(result.get('apps/admin/src/')).toBe('2026-05-16T10:00:00Z')
    // The pre-fix bug: keys were the candidate TYPE prefix
    // ('security', 'tests') derived from a split-on-first-hyphen of the
    // branch suffix. scoreAreas's botPRs.get(area) lookup returned
    // undefined for every real area, capping the recency bonus at 60d.
    expect(result.has('security')).toBe(false)
    expect(result.has('tests')).toBe(false)
  })

  it('drops PRs older than sinceDays cutoff', () => {
    const oldBranch = fingerprintToBranch({
      area: 'packages/gazetta/src/legacy/',
      type: 'correctness',
      rule: 'design-X.md#old',
    })
    const newBranch = fingerprintToBranch({
      area: 'packages/gazetta/src/auth/',
      type: 'security',
      rule: 'design-Y.md#new',
    })
    const stdout = JSON.stringify([
      { headRefName: oldBranch, createdAt: '2024-01-01T00:00:00Z' }, // ancient
      { headRefName: newBranch, createdAt: '2026-05-17T10:00:00Z' },
    ])
    const result = parseBotPRs(stdout, 30)
    expect(result.has('packages/gazetta/src/legacy/')).toBe(false)
    expect(result.has('packages/gazetta/src/auth/')).toBe(true)
  })

  it('handles empty / malformed JSON gracefully', () => {
    expect(parseBotPRs('', 30).size).toBe(0)
    expect(parseBotPRs('not-json', 30).size).toBe(0)
    expect(parseBotPRs('[]', 30).size).toBe(0)
  })

  it('skips PRs without headRefName, createdAt, or with an unrecognized branch shape', () => {
    const stdout = JSON.stringify([
      { headRefName: 'improve/x-1' }, // missing createdAt
      { createdAt: '2026-05-17T10:00:00Z' }, // missing headRefName
      { headRefName: 'main' }, // not an improve/* branch
      { headRefName: 'improve/unknown-type-foo-bar', createdAt: '2026-05-17T10:00:00Z' }, // not a known type
    ])
    expect(parseBotPRs(stdout, 30).size).toBe(0)
  })

  it('round-trips: parseBotPRs(fingerprintToBranch(fp)) → Map key === fp.area', () => {
    // Direct contract test. The failing-test asserts the bug fix: the
    // Map key for a real bot-authored branch must equal the originating
    // candidate's `fp.area`, otherwise scoreAreas's botPRs.get(area)
    // lookup misses and daysSinceBotTouched stays Infinity for every
    // real PR — making the cold-on-bot scoring signal dead code.
    const cases: Fingerprint[] = [
      { area: 'packages/gazetta/src/auth/', type: 'security', rule: 'design-auth-rbac.md#capability-gate' },
      { area: 'apps/admin/src/', type: 'tests', rule: 'testing-plan.md#26' },
      { area: 'packages/gazetta/src/audit/', type: 'architecture', rule: 'design-audit.md' },
      { area: 'packages/gazetta/src/foo/', type: 'types', rule: 'design-X.md#anchor' },
    ]
    for (const fp of cases) {
      const branch = fingerprintToBranch(fp)
      const stdout = JSON.stringify([{ headRefName: branch, createdAt: '2026-05-17T10:00:00Z' }])
      const result = parseBotPRs(stdout, 180)
      expect(result.get(fp.area), `round-trip failed for ${branch} (fp.area=${fp.area})`).toBe(
        '2026-05-17T10:00:00Z',
      )
    }
  })
})

describe('parsePickerOutput', () => {
  it('parses a clean PICK line with Reasoning', () => {
    const text = `Some narration here.\n> Decision: foo\nPICK: packages/gazetta/src/auth/\nReasoning: foundational area; cold-on-bot 45 days`
    const r = parsePickerOutput(text)
    expect(r.area).toBe('packages/gazetta/src/auth/')
    expect(r.reasoning).toContain('cold-on-bot')
  })

  it('parses PICK: NONE', () => {
    const r = parsePickerOutput('PICK: NONE\nReasoning: nothing eligible after skip-list filter')
    expect(r.area).toBe(null)
    expect(r.reasoning).toContain('nothing eligible')
  })

  it('returns null area when no PICK line present', () => {
    const r = parsePickerOutput('I think we should pick auth.')
    expect(r.area).toBe(null)
    expect(r.reasoning).toContain('no PICK')
  })

  it('finds the LAST PICK line when multiple present (defensive)', () => {
    const text = `PICK: packages/wrong/\nLater on...\nPICK: packages/right/\nReasoning: final decision`
    const r = parsePickerOutput(text)
    expect(r.area).toBe('packages/right/')
  })
})
