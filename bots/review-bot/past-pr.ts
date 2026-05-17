/**
 * Past-PR helper — feedback loop for review-bot.
 *
 * Before the bot files a fresh improve/* PR for a candidate, it checks
 * whether it has previously tried this exact candidate. The outcome of
 * the past PR determines whether to retry, skip, or generate a skip-list
 * entry from the maintainer's rejection reason.
 *
 * Branch-naming convention: each candidate gets a deterministic branch
 * name derived from its fingerprint. PR history is searchable by
 * branch (`head` field).
 */
import type { Octokit } from '@octokit/rest'
import type { RepoIdentity } from '../_lib/github.js'
import type { Fingerprint } from './skip-list.js'

/** Outcome of the bot's last attempt on this fingerprint. */
export type PastOutcome =
  /** No prior PR exists for this fingerprint — fresh attempt OK. */
  | { state: 'none' }
  /** PR was opened and merged — candidate was fixed; skip + clear from skip-list. */
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
 * Branch-name convention: encode the fingerprint into a filesystem-safe
 * form. We need the branch name to round-trip back to a recognizable
 * fingerprint when searching past PRs.
 *
 * Format: `improve/<type>-<encoded-area>-<rule-tail>`
 *
 *   - `type`: lowercased (security, architecture, tests, ...)
 *   - `area`: slashes → double-dash; trailing slash dropped
 *   - `rule-tail`: short hash-like derivation of the rule citation,
 *     so two distinct candidates in the same area + type don't
 *     collide. We use the last segment of the rule (post-#anchor or
 *     post-/) as a stable identifier, then sanitize.
 *
 * Examples:
 *   - { area: 'packages/gazetta/src/auth/', type: 'security',
 *       rule: 'design-auth-rbac.md#capability-gate' }
 *     → `improve/security-packages--gazetta--src--auth-capability-gate`
 *
 *   - { area: 'apps/admin/src/', type: 'tests', rule: 'team-preferences.md#26' }
 *     → `improve/tests-apps--admin--src-26`
 */
export function fingerprintToBranch(fp: Fingerprint): string {
  const safeArea = fp.area.replace(/\/$/, '').replace(/\//g, '--')
  // Prefer the anchor (`#capability-gate`), fall back to the last path
  // segment (`design-audit.md`), then strip .md and sanitize.
  // `split('#').pop()` always returns a string (the whole rule when no #),
  // so we explicitly detect the no-# case via length comparison.
  const segments = fp.rule.split('#')
  const tailSource = segments.length > 1 ? segments[segments.length - 1]! : (fp.rule.split('/').pop() ?? fp.rule)
  const ruleTail = tailSource
    .replace(/\.md$/, '')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `improve/${fp.type}-${safeArea}-${ruleTail}`
}

/**
 * Inverse — parse a branch name back to (type, area, ruleTail).
 * Best-effort: rule tail is sanitized so we can't recover the original
 * doc#anchor exactly. Used for diagnostic logging only, not for
 * authoritative dedup (use fingerprintToBranch as the canonical key
 * for past-PR queries).
 */
export function branchToFingerprintLabel(branch: string): string {
  const stripped = branch.replace(/^improve\//, '')
  return stripped.replace(/--/g, '/')
}

/**
 * Query GitHub for the most recent PR matching this fingerprint's
 * branch. Returns the canonical PastOutcome for the bot's decision tree.
 *
 * When the PR is closed-not-merged (state='rejected'), mines a
 * `reasonNote` from the most recent maintainer comment with content.
 * If no comment text is found, falls back to a generic note.
 */
export async function pastPROutcome(octokit: Octokit, repo: RepoIdentity, fp: Fingerprint): Promise<PastOutcome> {
  const branch = fingerprintToBranch(fp)
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

  const pr = prs[0]!
  if (pr.state === 'open') return { state: 'open', prNumber: pr.number }
  if (pr.merged_at !== null && pr.merged_at !== undefined) {
    return { state: 'merged', prNumber: pr.number }
  }

  // Closed-not-merged: mine the rejection reason from the most recent
  // maintainer comment. Same conservative strategy as dead-code-watcher.
  const reasonNote = await mineRejectionReason(octokit, repo, pr.number)
  return { state: 'rejected', prNumber: pr.number, reasonNote }
}

async function mineRejectionReason(octokit: Octokit, repo: RepoIdentity, prNumber: number): Promise<string> {
  try {
    const { data: comments } = await octokit.issues.listComments({
      ...repo,
      issue_number: prNumber,
      per_page: 50,
    })
    // Most recent comment with non-empty body wins.
    for (let i = comments.length - 1; i >= 0; i--) {
      const c = comments[i]!
      if (c.body && c.body.trim().length > 0) {
        return c.body.slice(0, 500)
      }
    }
  } catch {
    // ignore — fallback note covers it
  }
  return 'PR was closed without merge — reason not recorded in comments'
}
