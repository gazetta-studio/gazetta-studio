import { describe, expect, it } from 'vitest'
import { branchToFingerprintLabel, fingerprintToBranch } from '../past-pr.js'
import type { Fingerprint } from '../skip-list.js'

describe('fingerprintToBranch', () => {
  it('encodes a typical security candidate', () => {
    const fp: Fingerprint = {
      area: 'packages/gazetta/src/auth/',
      type: 'security',
      rule: 'design-auth-rbac.md#capability-gate',
    }
    expect(fingerprintToBranch(fp)).toBe('improve/security-packages--gazetta--src--auth-capability-gate')
  })

  it('strips trailing slash from area', () => {
    const fp: Fingerprint = {
      area: 'apps/admin/src/',
      type: 'tests',
      rule: 'team-preferences.md#26',
    }
    expect(fingerprintToBranch(fp)).toBe('improve/tests-apps--admin--src-26')
  })

  it('handles rule without #anchor (last path segment)', () => {
    const fp: Fingerprint = {
      area: 'packages/gazetta/src/audit/',
      type: 'architecture',
      rule: '.claude/rules/design-audit.md',
    }
    const branch = fingerprintToBranch(fp)
    expect(branch).toMatch(/^improve\/architecture-packages--gazetta--src--audit-design-audit/)
  })

  it('sanitizes spaces and parens in area (reproduces review-bot run 26707064619 push crash)', () => {
    // audit-area sometimes emits a paired-target area with spaces and
    // parens, e.g. `packages/gazetta/tests/ (paired against
    // packages/gazetta/src/validation/validators/)`. The 07:56 review-bot
    // cron on 2026-05-31 reached APPROVE but crashed at `git push` with
    // `fatal: invalid refspec` because the branch name carried the
    // unsanitized text verbatim. Git refs cannot contain spaces or parens.
    const fp: Fingerprint = {
      area: 'packages/gazetta/tests/ (paired against packages/gazetta/src/validation/validators/)',
      type: 'tests',
      rule: 'testing-plan.md#pyramid',
    }
    const branch = fingerprintToBranch(fp)
    // Git refspec invariant — no whitespace, no parens, no other
    // ref-hostile characters in the branch.
    expect(branch).not.toMatch(/[\s()~^:?*[\\]/)
    // Sanity: still starts with the right prefix
    expect(branch).toMatch(/^improve\/tests-/)
    // Sanity: paired-target context still visible in some shape (not
    // completely erased)
    expect(branch).toMatch(/paired|packages/)
  })

  it('sanitizes non-alphanumeric characters in rule tail', () => {
    const fp: Fingerprint = {
      area: 'packages/gazetta/src/foo/',
      type: 'types',
      rule: 'design-X.md#some/weird@anchor!',
    }
    const branch = fingerprintToBranch(fp)
    // No #, @, or ! anywhere (those are unsafe in git refs).
    // The leading 'improve/' segment + the area's '/' separators are fine
    // for refs; we only sanitize the rule-tail portion.
    expect(branch).not.toMatch(/[#@!]/)
    expect(branch).toMatch(/^improve\/types-packages--gazetta--src--foo-some-weird-anchor/)
  })

  it('truncates very long rule tails', () => {
    const fp: Fingerprint = {
      area: 'packages/gazetta/src/foo/',
      type: 'comments',
      rule: 'design-X.md#'.padEnd(200, 'a'),
    }
    const branch = fingerprintToBranch(fp)
    // The rule-tail portion is capped at 40 chars
    const tail = branch.split('-comments-')[1] ?? ''
    expect(tail.length).toBeLessThanOrEqual(80) // path + 40-char rule tail
  })

  it('two distinct rules in same area+type produce distinct branches', () => {
    const a: Fingerprint = { area: 'apps/admin/src/', type: 'security', rule: 'design-X.md#aaa' }
    const b: Fingerprint = { area: 'apps/admin/src/', type: 'security', rule: 'design-X.md#bbb' }
    expect(fingerprintToBranch(a)).not.toBe(fingerprintToBranch(b))
  })

  it('same fingerprint produces same branch (deterministic)', () => {
    const fp: Fingerprint = {
      area: 'packages/gazetta/src/auth/',
      type: 'security',
      rule: 'design-auth-rbac.md#capability-gate',
    }
    expect(fingerprintToBranch(fp)).toBe(fingerprintToBranch(fp))
  })
})

describe('branchToFingerprintLabel', () => {
  it('extracts a human-readable label from a branch name', () => {
    const branch = 'improve/security-packages--gazetta--src--auth-capability-gate'
    expect(branchToFingerprintLabel(branch)).toBe('security-packages/gazetta/src/auth-capability-gate')
  })
})
