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
    comments: Array<{ body: string; user: { login: string; type?: string }; created_at: string }> = [],
    reviewComments: Array<{ body: string; user: { login: string; type?: string }; created_at: string }> = [],
  ): Parameters<typeof pastPROutcome>[0] {
    return {
      pulls: {
        list: vi.fn(async () => ({ data: prs })),
        listReviewComments: vi.fn(async () => ({ data: reviewComments })),
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
      [
        {
          body: 'bot comment',
          user: { login: 'github-actions[bot]', type: 'Bot' },
          created_at: '2026-05-12T00:00:00Z',
        },
      ],
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

  it('mines rejection reason from a review-comment when there are no issue-comments', async () => {
    // Pins that pulls.listReviewComments is actually read and folded into
    // the mined comment set. Without this test, deleting the review-
    // comments source from mineRejectionReason would leave every other
    // test green (they all seed only issue-comments).
    const octokit = mockOctokit(
      [{ number: 50, merged_at: null, state: 'closed' }],
      [],
      [
        {
          body: 'Inline review: this file is still exported publicly.',
          user: { login: 'maintainer', type: 'User' },
          created_at: '2026-05-16T00:00:00Z',
        },
      ],
    )
    const outcome = await pastPROutcome(octokit, repo, { kind: 'file', path: 'src/foo.ts' })
    expect(outcome.state).toBe('rejected')
    if (outcome.state === 'rejected') {
      expect(outcome.reasonNote).toContain('Maintainer (maintainer)')
      expect(outcome.reasonNote).toContain('this file is still exported publicly')
    }
  })

  it('picks the newest non-bot comment across mixed issue-comments and review-comments', async () => {
    // Older issue-comment + newer review-comment, both non-bot. Pins the
    // newest-first sort direction: flipping b.when.localeCompare(a.when)
    // to a.when.localeCompare(b.when) would surface the older issue-
    // comment as the reasonNote instead of the newer review-comment.
    const octokit = mockOctokit(
      [{ number: 51, merged_at: null, state: 'closed' }],
      [
        {
          body: 'older issue: needs more discussion',
          user: { login: 'maintainer', type: 'User' },
          created_at: '2026-05-10T00:00:00Z',
        },
      ],
      [
        {
          body: 'newer review: rejecting for concrete reason',
          user: { login: 'maintainer', type: 'User' },
          created_at: '2026-05-14T00:00:00Z',
        },
      ],
    )
    const outcome = await pastPROutcome(octokit, repo, { kind: 'file', path: 'src/foo.ts' })
    expect(outcome.state).toBe('rejected')
    if (outcome.state === 'rejected') {
      expect(outcome.reasonNote).toContain('newer review')
      expect(outcome.reasonNote).not.toContain('older issue')
    }
  })

  it('excludes non-github-actions bots (e.g. renovate[bot]) from rejection mining', async () => {
    // Mixed thread: older human maintainer comment + newer non-github-actions
    // bot comment. The predicate must exclude by user.type === 'Bot', not by
    // hardcoded 'github-actions[bot]' login string, else the bot's comment
    // gets mined as if it were the maintainer's rejection reason.
    const octokit = mockOctokit(
      [{ number: 47, merged_at: null, state: 'closed' }],
      [
        {
          body: 'This is public API; keep it.',
          user: { login: 'maintainer', type: 'User' },
          created_at: '2026-05-10T00:00:00Z',
        },
        {
          body: 'Automated: bumping dep to 4.2.0',
          user: { login: 'renovate[bot]', type: 'Bot' },
          created_at: '2026-05-14T00:00:00Z',
        },
      ],
    )
    const outcome = await pastPROutcome(octokit, repo, { kind: 'file', path: 'src/foo.ts' })
    expect(outcome.state).toBe('rejected')
    if (outcome.state === 'rejected') {
      expect(outcome.reasonNote).toContain('Maintainer (maintainer)')
      expect(outcome.reasonNote).toContain('public API')
      expect(outcome.reasonNote).not.toContain('Automated: bumping dep')
      expect(outcome.reasonNote).not.toContain('renovate[bot]')
    }
  })
})
