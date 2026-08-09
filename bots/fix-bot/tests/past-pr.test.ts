import { describe, expect, it, vi } from 'vitest'
import { issueNumberToBranch, pastPROutcome } from '../past-pr.js'

describe('issueNumberToBranch', () => {
  it('encodes issue number using the fix-bot branch convention', () => {
    expect(issueNumberToBranch(692)).toBe('fix/issue-692')
    expect(issueNumberToBranch(1)).toBe('fix/issue-1')
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

  it('returns state=none when no PR exists for this issue', async () => {
    const octokit = mockOctokit([])
    const outcome = await pastPROutcome(octokit, repo, 692)
    expect(outcome.state).toBe('none')
  })

  it('queries pulls.list with owner:branch head-ref keyed on the issue number', async () => {
    const list = vi.fn(async () => ({ data: [] }))
    const octokit = {
      pulls: { list, listReviewComments: vi.fn(async () => ({ data: [] })) },
      issues: { listComments: vi.fn(async () => ({ data: [] })) },
    } as unknown as Parameters<typeof pastPROutcome>[0]
    await pastPROutcome(octokit, repo, 692)
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ head: 'test-org:fix/issue-692', state: 'all' }))
  })

  it('returns state=merged when latest PR was merged', async () => {
    const octokit = mockOctokit([{ number: 42, merged_at: '2026-05-10T00:00:00Z', state: 'closed' }])
    const outcome = await pastPROutcome(octokit, repo, 100)
    expect(outcome).toEqual({ state: 'merged', prNumber: 42 })
  })

  it('returns state=open when latest PR is open', async () => {
    const octokit = mockOctokit([{ number: 43, merged_at: null, state: 'open' }])
    const outcome = await pastPROutcome(octokit, repo, 100)
    expect(outcome).toEqual({ state: 'open', prNumber: 43 })
  })

  it('mines rejection reason from non-bot comment when PR closed-not-merged', async () => {
    const octokit = mockOctokit(
      [{ number: 44, merged_at: null, state: 'closed' }],
      [
        {
          body: 'Wrong root cause; the bug is in the parser.',
          user: { login: 'maintainer' },
          created_at: '2026-05-12T00:00:00Z',
        },
      ],
    )
    const outcome = await pastPROutcome(octokit, repo, 100)
    expect(outcome.state).toBe('rejected')
    if (outcome.state === 'rejected') {
      expect(outcome.prNumber).toBe(44)
      expect(outcome.reasonNote).toContain('Maintainer (maintainer)')
      expect(outcome.reasonNote).toContain('Wrong root cause')
      expect(outcome.reasonNote).toContain('#100')
    }
  })

  it('falls back to generic note when no maintainer comment exists', async () => {
    const octokit = mockOctokit(
      [{ number: 45, merged_at: null, state: 'closed' }],
      [{ body: 'bot comment', user: { login: 'github-actions[bot]' }, created_at: '2026-05-12T00:00:00Z' }],
    )
    const outcome = await pastPROutcome(octokit, repo, 100)
    expect(outcome.state).toBe('rejected')
    if (outcome.state === 'rejected') {
      expect(outcome.reasonNote).toContain('closed without merge')
      expect(outcome.reasonNote).toContain('no maintainer comment')
    }
  })

  it('truncates long maintainer comments', async () => {
    const longBody = 'x'.repeat(600)
    const octokit = mockOctokit(
      [{ number: 46, merged_at: null, state: 'closed' }],
      [{ body: longBody, user: { login: 'maintainer' }, created_at: '2026-05-12T00:00:00Z' }],
    )
    const outcome = await pastPROutcome(octokit, repo, 100)
    if (outcome.state === 'rejected') {
      expect(outcome.reasonNote.length).toBeLessThan(longBody.length)
      expect(outcome.reasonNote).toContain('…')
    }
  })

  it('picks the most recent non-bot comment from mixed issue + review comments', async () => {
    // Simulate BOTH issue comments and review comments; the newest non-bot one wins.
    const listComments = vi.fn(async () => ({
      data: [{ body: 'earlier issue comment', user: { login: 'maintainer' }, created_at: '2026-05-10T00:00:00Z' }],
    }))
    const listReviewComments = vi.fn(async () => ({
      data: [
        {
          body: 'newer inline review comment: this is the wrong approach',
          user: { login: 'maintainer' },
          created_at: '2026-05-14T00:00:00Z',
        },
      ],
    }))
    const octokit = {
      pulls: {
        list: vi.fn(async () => ({ data: [{ number: 47, merged_at: null, state: 'closed' }] })),
        listReviewComments,
      },
      issues: { listComments },
    } as unknown as Parameters<typeof pastPROutcome>[0]
    const outcome = await pastPROutcome(octokit, repo, 100)
    expect(outcome.state).toBe('rejected')
    if (outcome.state === 'rejected') {
      expect(outcome.reasonNote).toContain('wrong approach')
      expect(outcome.reasonNote).not.toContain('earlier issue comment')
    }
  })

  it('excludes non-github-actions bots (e.g. renovate[bot]) from rejection mining', async () => {
    // Mixed thread: older human maintainer comment + newer non-github-actions
    // bot comment. The predicate must exclude by user.type === 'Bot', not by
    // hardcoded 'github-actions[bot]' login string, else the bot's comment
    // gets mined as if it were the maintainer's rejection reason.
    const octokit = mockOctokit(
      [{ number: 48, merged_at: null, state: 'closed' }],
      [
        {
          body: 'The bug is in the schema.',
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
    const outcome = await pastPROutcome(octokit, repo, 100)
    expect(outcome.state).toBe('rejected')
    if (outcome.state === 'rejected') {
      expect(outcome.reasonNote).toContain('Maintainer (maintainer)')
      expect(outcome.reasonNote).toContain('The bug is in the schema.')
      expect(outcome.reasonNote).not.toContain('Automated: bumping dep')
      expect(outcome.reasonNote).not.toContain('renovate[bot]')
    }
  })
})
