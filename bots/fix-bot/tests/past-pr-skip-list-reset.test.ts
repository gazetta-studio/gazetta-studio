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
 * The 6-step git+gh pipeline was extracted into `openSkipListPR` (see
 * `open-skip-list-pr.ts`) so the reset-first sequence lives in one
 * place. `openSkipListPR`'s own behavioral tests
 * (`open-skip-list-pr.test.ts`) assert the reset-first ordering
 * against stubbed execFileSync; the tests below verify that
 * `openPastPRSkipListPR` routes through the helper AND passes a
 * branchName derived from issueNumber so the fix/issue-N branch gets
 * cleaned up. `main`'s outer-loop reset (added alongside the original
 * fix) still lives inline and stays pinned here.
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

  it('routes through openSkipListPR (which owns the reset-first sequence)', () => {
    // The reset-first invariant lives in the extracted helper. Verify
    // openPastPRSkipListPR actually invokes it — otherwise the
    // extraction would ship as dead code and the inline 6-step
    // pipeline would still be duplicated (rule 18 SRP violation).
    const body = openPastPRSkipListPRBody()
    expect(body).toMatch(/openSkipListPR\s*\(/)
  })

  it('passes a branchName derived from issueNumber to openSkipListPR', () => {
    // The function only receives `issueNumber` in its signature; the
    // caller must construct the in-flight branch name (`fix/issue-<N>`)
    // from it and pass it to openSkipListPR so the helper's reset step
    // cleans up any stale local branch of that name. Hardcoding 'main'
    // or some other literal would leave fix/issue-N behind for the
    // next cron.
    const body = openPastPRSkipListPRBody()
    // Match a branchName option that references issueNumber (allowing
    // template-literal syntax `fix/issue-${issueNumber}` OR any
    // expression that names `issueNumber`).
    expect(body).toMatch(/branchName\s*:\s*[^,\n]*issueNumber/)
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
