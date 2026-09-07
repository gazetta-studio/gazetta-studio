/**
 * Shared helper for filing a fix-bot skip-list PR.
 *
 * Owns the 6-step pipeline that `escalateToHuman` and
 * `openPastPRSkipListPR` used to duplicate inline (~60 LOC of
 * parallel code, rule-15's 3-caller threshold at 2 but rule 18 —
 * SRP at file creation — applies because the two functions were
 * written parallel-shape from the start).
 *
 *   1. resetToMain(branchName)   — return to clean main before branching
 *      the skip-list PR so it doesn't carry Agent A's fix/issue-N
 *      commits (the class of bug escalate-to-human-reset.test.ts +
 *      past-pr-skip-list-reset.test.ts pin against regression)
 *   2. git checkout -b <skipBranchName>
 *   3. git add <skipListPath>
 *   4. git commit -m <commitMessage>
 *   5. git push -u --force-with-lease origin <skipBranchName>   —
 *      --force-with-lease is load-bearing (see
 *      push-force-with-lease.test.ts) so reruns against a stale
 *      leftover skip-list branch of the same name replace it instead
 *      of silently failing as non-fast-forward
 *   6. gh pr create --draft --title <prTitle> --body <prBody>
 *   7. (finally) git checkout main   — hop back so the outer loop
 *      sees a clean HEAD regardless of whether the try block threw
 *
 * Best-effort throughout: a failure in the try block still runs the
 * finally-block `git checkout main`; a failure there is swallowed
 * (workflow log carries the diagnostic either way).
 */
import { execFileSync } from 'node:child_process'
import { resetToMain } from '../_lib/git-tree.js'
import { printNotice, printWarning } from '../_lib/ui.js'

export interface OpenSkipListPROptions {
  /** The in-flight fix branch to clean up first (e.g. `fix/issue-42`). */
  branchName: string
  /** New branch name for the skip-list PR (e.g. `fix-bot-skip/2026-06-01-issue-42`). */
  skipBranchName: string
  /** Commit message body for the skip-list update. */
  commitMessage: string
  /** PR title. */
  prTitle: string
  /** PR body (markdown). */
  prBody: string
  /** Repo working-directory root. */
  cwd: string
  /** Repo-relative path to `skip-list.json`. */
  skipListPath: string
  /** Issue number this skip-list PR is filed for. Used in log strings. */
  issueNumber: number
  /**
   * Optional context suffix appended to log strings (e.g. `"past-PR"`
   * distinguishes the two call sites in workflow logs).
   */
  contextLabel?: string
}

export function openSkipListPR(opts: OpenSkipListPROptions): void {
  resetToMain(opts.branchName, { cwd: opts.cwd })
  const suffix = opts.contextLabel ? ` (${opts.contextLabel})` : ''
  try {
    execFileSync('git', ['checkout', '-b', opts.skipBranchName], { cwd: opts.cwd, stdio: 'inherit' })
    execFileSync('git', ['add', opts.skipListPath], { cwd: opts.cwd, stdio: 'inherit' })
    execFileSync('git', ['commit', '-m', opts.commitMessage], { cwd: opts.cwd, stdio: 'inherit' })
    execFileSync('git', ['push', '-u', '--force-with-lease', 'origin', opts.skipBranchName], {
      cwd: opts.cwd,
      stdio: 'inherit',
    })
    execFileSync(
      'gh',
      ['pr', 'create', '--draft', '--title', opts.prTitle, '--body', opts.prBody],
      { cwd: opts.cwd, stdio: 'inherit' },
    )
    printNotice(`Opened skip-list-entry PR for #${opts.issueNumber}${suffix}`)
  } catch (err) {
    printWarning(`Couldn't open skip-list PR for #${opts.issueNumber}${suffix}: ${err}`)
  } finally {
    try {
      execFileSync('git', ['checkout', 'main'], { cwd: opts.cwd, stdio: 'inherit' })
    } catch {
      // best-effort
    }
  }
}
