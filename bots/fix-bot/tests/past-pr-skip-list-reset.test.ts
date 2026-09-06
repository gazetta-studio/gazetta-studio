/**
 * Regression: two ordering invariants prevent skip-list / cross-candidate
 * PRs from carrying unrelated fix commits.
 *
 * Bug (rule-38 symmetric-audit gap against
 * `escalate-to-human-reset.test.ts`): after a prior candidate in the
 * same cron pushed `fix/issue-M`, HEAD stays on that branch —
 * `pushBranch` doesn't checkout back to main. When the next candidate's
 * past-PR check returns `state === 'rejected'`, `openPastPRSkipListPR`
 * runs BEFORE the attempt loop's own `resetToMain`, so
 * `git checkout -b fix-bot-skip/...` branches off `fix/issue-M` and the
 * skip-list PR carries M's failing-test + attempted-fix commits
 * alongside the skip-list update — muddying review and landing
 * unwanted commits on main if merged.
 *
 * The existing test at `escalate-to-human-reset.test.ts` locked the
 * same invariant for `escalateToHuman`; `openPastPRSkipListPR` has the
 * exact same shape and was missed at the time.
 *
 * Fix has two parts:
 *   1. Add `resetToMain` at the top of `openPastPRSkipListPR` (site
 *      fix — mirrors the escalateToHuman fix).
 *   2. Add `resetToMain` in main()'s outer for-loop between candidates
 *      so HEAD is deterministic entering each `fixOneIssue`. This
 *      closes the class at the entry point rather than depending on
 *      each internal branch-creating site to reset.
 *
 * Structural test in the same shape as
 * `escalate-to-human-reset.test.ts`: ordering invariants inside
 * function bodies, directly checkable on source. Behavioral coverage
 * (stubbing `execFileSync` + octokit + fs) would require heavy mocking
 * with no proportional gain over the ordering assertion.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX_PATH = resolve(HERE, '..', 'index.ts')
const source = readFileSync(INDEX_PATH, 'utf-8')

function openPastPRSkipListPRBody(): string {
  const match = source.match(/async function openPastPRSkipListPR\([\s\S]+?\n\}\n/)
  if (!match) throw new Error('openPastPRSkipListPR function not found in source')
  return match[0]
}

function mainBody(): string {
  const match = source.match(/async function main\(\)[\s\S]+?\n\}\n/)
  if (!match) throw new Error('main function not found in source')
  return match[0]
}

describe('openPastPRSkipListPR — reset to main before branching skip-list PR', () => {
  it('exists as an async function in index.ts', () => {
    expect(source).toMatch(/async function openPastPRSkipListPR\(/)
  })

  it('calls resetToMain before creating the fix-bot-skip branch', () => {
    // The load-bearing assertion: reset happens BEFORE `git checkout -b
    // skipBranch` so the skip-list PR branches from clean main, not from
    // a prior candidate's `fix/issue-M` with unrelated fix commits.
    const body = openPastPRSkipListPRBody()
    const resetIdx = body.search(/resetToMain\s*\(/)
    const checkoutBIdx = body.search(/['"]checkout['"]\s*,\s*['"]-b['"]\s*,\s*skipBranch/)
    expect(resetIdx, 'resetToMain call must exist inside openPastPRSkipListPR').toBeGreaterThan(-1)
    expect(checkoutBIdx, 'git checkout -b skipBranch must exist inside openPastPRSkipListPR').toBeGreaterThan(-1)
    expect(resetIdx).toBeLessThan(checkoutBIdx)
  })

  it('resets using a branch name derived from issueNumber (not a hardcoded string)', () => {
    // The function only receives `issueNumber` in its signature; the fix
    // should derive the in-flight branch name (`fix/issue-<N>`) from it
    // so any stale local branch of that name gets cleaned up by
    // resetToMain's `branch -D` step. Hardcoding 'main' or some other
    // literal would leave fix/issue-N behind for the next cron.
    const body = openPastPRSkipListPRBody()
    const resetMatch = body.match(/resetToMain\s*\(\s*([^,]+),/)
    expect(resetMatch, 'resetToMain call must accept a branch-name argument').not.toBeNull()
    expect(resetMatch![1]).toMatch(/issueNumber/)
  })
})

describe('main() candidate loop — reset between candidates', () => {
  it('calls resetToMain inside the for-of candidate loop before invoking fixOneIssue', () => {
    // Closes the class of "HEAD dirty entering fixOneIssue" bugs at the
    // entry point. Without this, any future function called BEFORE the
    // attempt-loop's own resetToMain (line ~396) that branches from HEAD
    // repeats the class of bug `openPastPRSkipListPR` just had.
    //
    // Note: main() also has a manual-one-issue-mode call to fixOneIssue
    // that short-circuits before the loop. This test asserts the reset
    // exists WITHIN the for-of loop (search relative to the for-of
    // position, not from the top of main()).
    const body = mainBody()
    const forOfIdx = body.search(/for\s*\(\s*const\s+candidate\s+of\s+candidates\s*\)/)
    expect(forOfIdx, 'for-of loop over candidates must exist in main').toBeGreaterThan(-1)
    const bodyAfterForOf = body.slice(forOfIdx)
    const resetIdx = bodyAfterForOf.search(/resetToMain\s*\(/)
    const fixOneCallIdx = bodyAfterForOf.search(/fixOneIssue\s*\(/)
    expect(resetIdx, 'resetToMain call must exist inside the candidate for-of loop').toBeGreaterThan(-1)
    expect(fixOneCallIdx, 'fixOneIssue call must exist inside the candidate for-of loop').toBeGreaterThan(-1)
    expect(resetIdx).toBeLessThan(fixOneCallIdx)
  })
})
