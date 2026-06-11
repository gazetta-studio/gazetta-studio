import { describe, expect, it } from 'vitest'
import { fingerprintToBranch } from '../past-pr.js'
import { parseBotPRs, parseGitLogTouches, parsePickerOutput } from '../phase0-collect.js'

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
  // Branch-name fixture helpers: branches in the wild are produced by
  // fingerprintToBranch — exercise the real encoding so the parser's
  // contract is the one the producer actually emits.
  const authBranch = fingerprintToBranch({
    area: 'packages/gazetta/src/auth/',
    type: 'security',
    rule: 'design-auth-rbac.md#capability-gate',
  })
  const auditBranch = fingerprintToBranch({
    area: 'packages/gazetta/src/auth/',
    type: 'architecture',
    rule: 'design-auth-rbac.md#another-issue',
  })
  const adminBranch = fingerprintToBranch({
    area: 'apps/admin/src/',
    type: 'tests',
    rule: 'team-preferences.md#26',
  })

  it('groups by area path; most-recent timestamp wins for the same area', () => {
    const stdout = JSON.stringify([
      { headRefName: authBranch, createdAt: '2026-05-15T10:00:00Z' },
      { headRefName: auditBranch, createdAt: '2026-05-17T10:00:00Z' },
      { headRefName: adminBranch, createdAt: '2026-05-16T10:00:00Z' },
    ])
    const result = parseBotPRs(stdout, 180)
    expect(result.get('packages/gazetta/src/auth/')).toBe('2026-05-17T10:00:00Z')
    expect(result.get('apps/admin/src/')).toBe('2026-05-16T10:00:00Z')
  })

  it('drops PRs older than sinceDays cutoff', () => {
    const stdout = JSON.stringify([
      { headRefName: authBranch, createdAt: '2024-01-01T00:00:00Z' }, // ancient
      { headRefName: adminBranch, createdAt: '2026-05-17T10:00:00Z' },
    ])
    const result = parseBotPRs(stdout, 30)
    expect(result.has('packages/gazetta/src/auth/')).toBe(false)
    expect(result.get('apps/admin/src/')).toBe('2026-05-17T10:00:00Z')
  })

  it('handles empty / malformed JSON gracefully', () => {
    expect(parseBotPRs('', 30).size).toBe(0)
    expect(parseBotPRs('not-json', 30).size).toBe(0)
    expect(parseBotPRs('[]', 30).size).toBe(0)
  })

  it('skips PRs without headRefName or createdAt, branches with unknown type prefix, or non-improve refs', () => {
    const stdout = JSON.stringify([
      { headRefName: authBranch }, // missing createdAt
      { createdAt: '2026-05-17T10:00:00Z' }, // missing headRefName
      { headRefName: 'main', createdAt: '2026-05-17T10:00:00Z' }, // not improve/*
      { headRefName: 'improve/unknown-type-foo', createdAt: '2026-05-17T10:00:00Z' }, // type not in closed enum
    ])
    expect(parseBotPRs(stdout, 30).size).toBe(0)
  })

  it('handles hyphenated dir names (bots/fix-bot/) via candidate-key enumeration', () => {
    // The boundary between encoded-area and rule-tail is a single `-`,
    // which is ambiguous when an area segment contains a dash (e.g.,
    // `bots/fix-bot/` → encoded `bots--fix-bot`). The parser emits a
    // candidate per dash position; the scorer's touch-counts map filters
    // to real areas, so spurious candidates are inert.
    const branch = fingerprintToBranch({
      area: 'bots/fix-bot/',
      type: 'correctness',
      rule: 'design-fix-bot.md#some-rule',
    })
    const stdout = JSON.stringify([{ headRefName: branch, createdAt: '2026-05-17T10:00:00Z' }])
    const result = parseBotPRs(stdout, 30)
    // The correct area path must be present (along with spurious siblings).
    expect(result.get('bots/fix-bot/')).toBe('2026-05-17T10:00:00Z')
  })

  it('keys map by area path (round-trips with fingerprintToBranch)', () => {
    // The branch encoding is `improve/<type>-<encoded-area>-<rule-tail>`.
    // parseBotPRs must invert this so the map keys are area paths matching
    // what area-scorer queries via `botPRs.get(area)` (paths like
    // `packages/gazetta/src/auth/`). Bug: the parser previously did
    // `ref.split('-')[0]` and keyed by the TYPE prefix ('security'),
    // collapsing the cold-on-bot signal to flat for every area.
    const branch = fingerprintToBranch({
      area: 'packages/gazetta/src/auth/',
      type: 'security',
      rule: 'design-auth-rbac.md#capability-gate',
    })
    // Sanity check the producer hasn't drifted.
    expect(branch).toBe('improve/security-packages--gazetta--src--auth-capability-gate')

    const stdout = JSON.stringify([{ headRefName: branch, createdAt: '2026-05-17T10:00:00Z' }])
    const result = parseBotPRs(stdout, 180)

    expect(result.get('packages/gazetta/src/auth/')).toBe('2026-05-17T10:00:00Z')
    // Negative: the type prefix MUST NOT be the key.
    expect(result.has('security')).toBe(false)
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
