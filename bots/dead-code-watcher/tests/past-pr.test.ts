import { describe, expect, it, vi } from 'vitest'
import { fingerprintToBranch, pastPROutcome } from '../past-pr.js'

describe('fingerprintToBranch', () => {
  it('encodes file findings with double-dash path separator', () => {
    expect(fingerprintToBranch({ kind: 'file', path: 'src/foo.ts' })).toBe('dead-code/file-src--foo.ts')
  })

  it('encodes export findings with -at-symbol suffix', () => {
    expect(fingerprintToBranch({ kind: 'export', path: 'src/foo.ts', symbol: 'bar' })).toBe(
      'dead-code/export-src--foo.ts-at-bar',
    )
  })

  it('encodes nested paths preserving slashes as double-dash', () => {
    expect(fingerprintToBranch({ kind: 'export', path: 'packages/gazetta/src/foo.ts', symbol: 'X' })).toBe(
      'dead-code/export-packages--gazetta--src--foo.ts-at-X',
    )
  })

  it('encodes deps without symbol on path', () => {
    expect(fingerprintToBranch({ kind: 'dependency', path: 'apps/admin/package.json', symbol: 'lodash' })).toBe(
      'dead-code/dependency-apps--admin--package.json-at-lodash',
    )
  })
})

describe('pastPROutcome', () => {
  const repo = { owner: 'test-org', repo: 'test-repo' }

  function mockOctokit(
    prs: Array<Partial<{ number: number; merged_at: string | null; state: string }>>,
    comments: Array<{ body: string; user: { login: string }; created_at: string }> = [],
  ): Parameters<typeof pastPROutcome>[0] {
    return {
      pulls: {
        list: vi.fn(async () => ({ data: prs })),
        listReviewComments: vi.fn(async () => ({ data: [] })),
      },
      issues: {
        listComments: vi.fn(async () => ({ data: comments })),
      },
    } as unknown as Parameters<typeof pastPROutcome>[0]
  }

  it('returns state=none when no PR exists for this fingerprint', async () => {
    const octokit = mockOctokit([])
    const outcome = await pastPROutcome(octokit, repo, { kind: 'file', path: 'src/foo.ts' })
    expect(outcome.state).toBe('none')
  })

  it('returns state=merged when latest PR was merged', async () => {
    const octokit = mockOctokit([{ number: 42, merged_at: '2026-05-10T00:00:00Z', state: 'closed' }])
    const outcome = await pastPROutcome(octokit, repo, { kind: 'file', path: 'src/foo.ts' })
    expect(outcome).toEqual({ state: 'merged', prNumber: 42 })
  })

  it('returns state=open when latest PR is open', async () => {
    const octokit = mockOctokit([{ number: 43, merged_at: null, state: 'open' }])
    const outcome = await pastPROutcome(octokit, repo, { kind: 'file', path: 'src/foo.ts' })
    expect(outcome).toEqual({ state: 'open', prNumber: 43 })
  })

  it('mines rejection reason from non-bot comment when PR closed-not-merged', async () => {
    const octokit = mockOctokit(
      [{ number: 44, merged_at: null, state: 'closed' }],
      [{ body: 'This is public API; keep it.', user: { login: 'maintainer' }, created_at: '2026-05-12T00:00:00Z' }],
    )
    const outcome = await pastPROutcome(octokit, repo, { kind: 'file', path: 'src/foo.ts' })
    expect(outcome.state).toBe('rejected')
    if (outcome.state === 'rejected') {
      expect(outcome.prNumber).toBe(44)
      expect(outcome.reasonNote).toContain('Maintainer (maintainer)')
      expect(outcome.reasonNote).toContain('public API')
    }
  })

  it('falls back to generic note when no maintainer comment exists', async () => {
    const octokit = mockOctokit(
      [{ number: 45, merged_at: null, state: 'closed' }],
      // Only bot comments
      [{ body: 'bot comment', user: { login: 'github-actions[bot]' }, created_at: '2026-05-12T00:00:00Z' }],
    )
    const outcome = await pastPROutcome(octokit, repo, { kind: 'file', path: 'src/foo.ts' })
    expect(outcome.state).toBe('rejected')
    if (outcome.state === 'rejected') {
      expect(outcome.reasonNote).toContain('closed without merge; no maintainer comment')
    }
  })

  it('truncates long maintainer comments', async () => {
    const longBody = 'x'.repeat(600)
    const octokit = mockOctokit(
      [{ number: 46, merged_at: null, state: 'closed' }],
      [{ body: longBody, user: { login: 'maintainer' }, created_at: '2026-05-12T00:00:00Z' }],
    )
    const outcome = await pastPROutcome(octokit, repo, { kind: 'file', path: 'src/foo.ts' })
    if (outcome.state === 'rejected') {
      // Truncated at 400 chars + ellipsis + the framing text
      expect(outcome.reasonNote.length).toBeLessThan(longBody.length)
      expect(outcome.reasonNote).toContain('…')
    }
  })
})
