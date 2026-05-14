/**
 * Past-PR helper — implements the feedback loop for dead-code-watcher.
 *
 * Before the bot files a fresh delete-PR for a finding, it checks
 * whether it has previously tried this exact finding. The outcome of
 * the past PR determines whether to retry, skip, or generate a
 * skip-list entry from the maintainer's rejection reason.
 *
 * Branch-naming convention: each finding gets a deterministic branch
 * name derived from its fingerprint. PR history is searchable by
 * branch (`head` field). This is the orchestration-layer dedup
 * pattern; the bot's outcome-tag in PR body is the orchestration-
 * layer audit trail.
 */
import type { RepoIdentity } from '../_lib/github.js'
import type { Octokit } from '@octokit/rest'
import type { Fingerprint } from './skip-list.js'
import { formatFingerprint } from './skip-list.js'

/** Outcome of the bot's last attempt on this fingerprint. */
export type PastOutcome =
  /** No prior PR exists for this fingerprint — fresh attempt OK. */
  | { state: 'none' }
  /** PR was opened and merged — finding should no longer be in knip output, but if it is, retry. */
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
 * Branch-name convention: encode the fingerprint into a filesystem-
 * safe form. We need the branch name to round-trip back to a
 * recognizable fingerprint when searching past PRs.
 *
 * Format: `dead-code/<kind>-<encoded-path>[-at-<encoded-symbol>]`
 *
 *   - `kind`: lowercased
 *   - `path`: slashes → double-dash (so `src/foo.ts` → `src--foo.ts`)
 *   - `symbol`: appended after `-at-` when present
 *
 * Examples:
 *   - file:src/foo.ts → `dead-code/file-src--foo.ts`
 *   - export:src/foo.ts#bar → `dead-code/export-src--foo.ts-at-bar`
 */
export function fingerprintToBranch(fp: Fingerprint): string {
  const safePath = fp.path.replace(/\//g, '--')
  const head = `${fp.kind}-${safePath}`
  return fp.symbol ? `dead-code/${head}-at-${fp.symbol}` : `dead-code/${head}`
}

/**
 * Query GitHub for the most recent PR matching this fingerprint's
 * branch. Returns the canonical PastOutcome for the bot's decision
 * tree.
 *
 * When the PR is closed-not-merged (state='rejected'), mines a
 * `reasonNote` from the most recent maintainer comment with content.
 * If no comment text is found, falls back to a generic "PR was
 * closed without merge — reason not recorded in comments."
 */
export async function pastPROutcome(octokit: Octokit, repo: RepoIdentity, fp: Fingerprint): Promise<PastOutcome> {
  const branch = fingerprintToBranch(fp)
  // Octokit's pulls.list takes `head: owner:branch` for filtering.
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
  // Most-recent PR is canonical (sort by updated_at desc).
  const pr = prs[0]
  if (pr.merged_at) return { state: 'merged', prNumber: pr.number }
  if (pr.state === 'open') return { state: 'open', prNumber: pr.number }
  // Closed without merge — mine rejection reason.
  const reasonNote = await mineRejectionReason(octokit, repo, pr.number, formatFingerprint(fp))
  return { state: 'rejected', prNumber: pr.number, reasonNote }
}

/**
 * Read the PR's most recent issue comment + review comment, pick
 * whichever is more recent + non-bot-authored, return a truncated
 * version. Falls back to a generic explanation when nothing useful
 * is found.
 *
 * Reads BOTH issue-comments (general PR discussion) and review-
 * comments (inline code review). Maintainer rejection can land in
 * either; we want whichever was last.
 */
async function mineRejectionReason(
  octokit: Octokit,
  repo: RepoIdentity,
  prNumber: number,
  fingerprintLabel: string,
): Promise<string> {
  // issues.listComments returns BOTH issue comments and PR-discussion
  // comments (GitHub treats PRs as a kind of issue). It does NOT
  // return inline review comments — those need pulls.listReviewComments.
  const [issueRes, reviewRes] = await Promise.all([
    octokit.issues.listComments({ ...repo, issue_number: prNumber, per_page: 50 }),
    octokit.pulls.listReviewComments({ ...repo, pull_number: prNumber, per_page: 50 }),
  ])
  const all = [
    ...issueRes.data.map(c => ({ body: c.body ?? '', login: c.user?.login ?? null, when: c.created_at })),
    ...reviewRes.data.map(c => ({ body: c.body ?? '', login: c.user?.login ?? null, when: c.created_at })),
  ]
    // Skip bot-authored content (the bot's own outcome-tag comment).
    .filter(c => c.login !== 'github-actions[bot]' && c.body.length > 0)
    // Sort newest-first; pick the first meaningful one.
    .sort((a, b) => b.when.localeCompare(a.when))
  if (all.length === 0) {
    return `PR for ${fingerprintLabel} was closed without merge; no maintainer comment recorded.`
  }
  const last = all[0]
  const truncated = last.body.length > 400 ? `${last.body.slice(0, 400)}…` : last.body
  return `Maintainer (${last.login ?? 'unknown'}) closed PR for ${fingerprintLabel}: "${truncated}"`
}
