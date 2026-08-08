/**
 * Past-PR helper — implements the feedback loop for fix-bot.
 *
 * Before the bot attempts a fix for an issue, it checks whether it
 * has previously tried this exact issue. The outcome of the past PR
 * determines whether to retry, skip, or generate a skip-list entry
 * from the maintainer's rejection reason.
 *
 * Symmetric with `bots/dead-code-watcher/past-pr.ts` per
 * [team-preferences rule 38](../../.claude/rules/team-preferences.md)
 * (audit symmetric bots when a pattern lands in one). Fingerprint
 * differs: fix-bot keys on the GitHub issue number, not on a knip
 * finding.
 *
 * Branch-naming convention: each issue gets a deterministic branch
 * name (`fix/issue-<N>`) matching the one fix-bot's orchestrator
 * uses when it commits + pushes the fix. PR history is searchable
 * by branch (`head` field).
 */
import type { RepoIdentity } from '../_lib/github.js'
import type { Octokit } from '@octokit/rest'

/** Outcome of the bot's last attempt on this issue. */
export type PastOutcome =
  /** No prior PR exists for this issue — fresh attempt OK. */
  | { state: 'none' }
  /** PR was opened and merged — issue is fixed; don't re-attempt. */
  | { state: 'merged'; prNumber: number }
  /** PR is currently open — wait for human review; don't double-PR. */
  | { state: 'open'; prNumber: number }
  /**
   * PR was closed without merge. The maintainer's rejection reason
   * (mined from close comment or last review comment) becomes the
   * skip-list entry's reasonNote.
   */
  | { state: 'rejected'; prNumber: number; reasonNote: string }

/**
 * The branch fix-bot's orchestrator commits + pushes onto. Must round-
 * trip so pastPROutcome can locate prior PRs via the `head` filter.
 * Change here → change also in `fix-bot/index.ts` at the branchName
 * construction site.
 */
export function issueNumberToBranch(issueNumber: number): string {
  return `fix/issue-${issueNumber}`
}

/**
 * Query GitHub for the most recent PR fix-bot filed against this
 * issue. Returns the canonical PastOutcome for the orchestrator's
 * decision tree.
 *
 * When the PR is closed-not-merged (state='rejected'), mines a
 * `reasonNote` from the most recent maintainer comment with content.
 * If no comment text is found, falls back to a generic "closed
 * without merge — reason not recorded in comments."
 */
export async function pastPROutcome(octokit: Octokit, repo: RepoIdentity, issueNumber: number): Promise<PastOutcome> {
  const branch = issueNumberToBranch(issueNumber)
  const headRef = `${repo.owner}:${branch}`
  const { data: prs } = await octokit.pulls.list({
    ...repo,
    head: headRef,
    state: 'all',
    sort: 'updated',
    direction: 'desc',
    per_page: 5,
  })
  if (prs.length === 0) return { state: 'none' }
  const pr = prs[0]
  if (pr.merged_at) return { state: 'merged', prNumber: pr.number }
  if (pr.state === 'open') return { state: 'open', prNumber: pr.number }
  const reasonNote = await mineRejectionReason(octokit, repo, pr.number, issueNumber)
  return { state: 'rejected', prNumber: pr.number, reasonNote }
}

/**
 * Read the PR's issue-comments + inline review-comments, pick the most
 * recent non-bot one, return a truncated version. Falls back to a
 * generic explanation when nothing useful is found.
 *
 * Reads BOTH surfaces because a maintainer rejection can land in
 * either the general PR discussion (issue-comments) or an inline
 * review-comment; we want whichever was last.
 */
async function mineRejectionReason(
  octokit: Octokit,
  repo: RepoIdentity,
  prNumber: number,
  issueNumber: number,
): Promise<string> {
  const [issueRes, reviewRes] = await Promise.all([
    octokit.issues.listComments({ ...repo, issue_number: prNumber, per_page: 50 }),
    octokit.pulls.listReviewComments({ ...repo, pull_number: prNumber, per_page: 50 }),
  ])
  const all = [
    ...issueRes.data.map(c => ({ body: c.body ?? '', login: c.user?.login ?? null, when: c.created_at })),
    ...reviewRes.data.map(c => ({ body: c.body ?? '', login: c.user?.login ?? null, when: c.created_at })),
  ]
    .filter(c => c.login !== 'github-actions[bot]' && c.body.length > 0)
    .sort((a, b) => b.when.localeCompare(a.when))
  if (all.length === 0) {
    return `PR for #${issueNumber} was closed without merge; no maintainer comment recorded.`
  }
  const last = all[0]
  const truncated = last.body.length > 400 ? `${last.body.slice(0, 400)}…` : last.body
  return `Maintainer (${last.login ?? 'unknown'}) closed PR for #${issueNumber}: "${truncated}"`
}
