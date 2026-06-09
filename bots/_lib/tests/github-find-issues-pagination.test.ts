import { describe, expect, it, vi } from 'vitest'
import { findIssuesByLabels } from '../github.js'

const REPO = { owner: 'gazetta-studio', repo: 'gazetta-studio' }

function makeIssue(n: number, labels: string[]) {
  return {
    number: n,
    title: `issue ${n}`,
    labels: labels.map(name => ({ name })),
    created_at: '2026-05-01T00:00:00Z',
    user: { login: 'someone' },
  }
}

describe('findIssuesByLabels pagination', () => {
  it('walks past page 1 so the client-side excludeAny filter sees all matches', async () => {
    // The exact failure mode rule 24 (5K envelope) warns about:
    // server-side `labels` prefilter matches 150 issues; the first 100
    // returned all carry an excludeAny label (e.g. `needs-info`), so the
    // single-page implementation silently returns an empty queue while
    // 50 fresh candidates wait on page 2. With pagination the bot sees
    // the 50.
    const page1 = Array.from({ length: 100 }, (_, i) => makeIssue(i + 1, ['bug', 'ready-for-agent', 'needs-info']))
    const page2 = Array.from({ length: 50 }, (_, i) => makeIssue(101 + i, ['bug', 'ready-for-agent']))

    const listForRepo = vi.fn().mockResolvedValueOnce({ data: page1 }).mockResolvedValueOnce({ data: page2 })

    const octokit = { issues: { listForRepo } } as never

    const issues = await findIssuesByLabels(octokit, REPO, {
      requireAll: ['bug', 'ready-for-agent'],
      excludeAny: ['needs-info'],
    })

    expect(issues).toHaveLength(50)
    expect(issues[0]?.number).toBe(101)
    expect(issues[49]?.number).toBe(150)

    // Pagination must have actually walked — both page=1 and page=2.
    expect(listForRepo).toHaveBeenCalledTimes(2)
    expect(listForRepo.mock.calls[0]?.[0]).toMatchObject({ page: 1, per_page: 100 })
    expect(listForRepo.mock.calls[1]?.[0]).toMatchObject({ page: 2, per_page: 100 })
  })

  it('stops paginating when a partial page comes back (data.length < per_page)', async () => {
    // Standard end-of-results signal: a short page means there are no
    // more pages. The implementation must NOT speculatively ask for an
    // additional page after seeing a partial one.
    const page1 = Array.from({ length: 100 }, (_, i) => makeIssue(i + 1, ['bug']))
    const page2 = Array.from({ length: 30 }, (_, i) => makeIssue(101 + i, ['bug']))

    const listForRepo = vi.fn().mockResolvedValueOnce({ data: page1 }).mockResolvedValueOnce({ data: page2 })

    const octokit = { issues: { listForRepo } } as never

    const issues = await findIssuesByLabels(octokit, REPO, {
      requireAll: ['bug'],
      excludeAny: [],
    })

    expect(issues).toHaveLength(130)
    expect(listForRepo).toHaveBeenCalledTimes(2)
  })

  it('respects the pageBudget ceiling', async () => {
    // 5K envelope + a degenerate query (no requireAll, only excludeAny):
    // the result set could be unbounded. pageBudget is the ceiling that
    // keeps the helper's worst case finite. Default budget = 5 pages
    // (500 issues); callers can override per-bot.
    const fullPage = Array.from({ length: 100 }, (_, i) => makeIssue(i + 1, ['bug']))

    const listForRepo = vi.fn().mockResolvedValue({ data: fullPage })
    const octokit = { issues: { listForRepo } } as never

    const issues = await findIssuesByLabels(octokit, REPO, { requireAll: ['bug'], excludeAny: [] }, { pageBudget: 2 })

    expect(issues).toHaveLength(200)
    expect(listForRepo).toHaveBeenCalledTimes(2)
  })

  it('returns the single page intact when there are fewer than per_page results', async () => {
    // No regression on the small-site happy path: the existing tests
    // are written against single-page responses; pagination must still
    // exit after one call when the first page is partial.
    const page1 = Array.from({ length: 5 }, (_, i) => makeIssue(i + 1, ['bug', 'ready-for-agent']))

    const listForRepo = vi.fn().mockResolvedValueOnce({ data: page1 })
    const octokit = { issues: { listForRepo } } as never

    const issues = await findIssuesByLabels(octokit, REPO, {
      requireAll: ['bug', 'ready-for-agent'],
      excludeAny: ['needs-info'],
    })

    expect(issues).toHaveLength(5)
    expect(listForRepo).toHaveBeenCalledTimes(1)
  })
})
