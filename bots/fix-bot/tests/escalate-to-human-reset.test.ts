/**
 * Regression: `escalateToHuman` must reset to clean main BEFORE branching
 * the skip-list PR.
 *
 * Bug: the three call sites at
 *   - `bResult.success === false` (Agent B crash)
 *   - `verdict.kind === 'needs-human'`
 *   - loop-exhausted branch
 * all reach `escalateToHuman` while sitting on `fix/issue-N` — that branch
 * already carries Agent A's failing-test commit + attempted-fix commit
 * from the current attempt. `resetToMain` only runs at attempt-loop entry,
 * so post-loop the working tree is NOT on clean main.
 *
 * Without a `resetToMain` at the top of `escalateToHuman`, the subsequent
 * `git checkout -b fix-bot-skip/<date>-issue-N` branches off `fix/issue-N`.
 * The skip-list PR then carries Agent A's failing test + attempted fix
 * commits alongside the skip-list update — muddying review + landing
 * unwanted commits on `main` if merged.
 *
 * Structural test in the same shape as `rate-limit-cascade-stop.test.ts`:
 * the invariant is ordering inside one function body, directly checkable
 * on source. Behavioral coverage (stubbing `execFileSync`) would require
 * mocking octokit + `writeSkipList` + fs with no proportional gain over
 * the ordering assertion.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX_PATH = resolve(HERE, '..', 'index.ts')
const source = readFileSync(INDEX_PATH, 'utf-8')

function escalateBody(): string {
  // Grab from `async function escalateToHuman(` up to the closing brace
  // at column 0 that ends the function.
  const match = source.match(/async function escalateToHuman\([\s\S]+?\n\}\n/)
  if (!match) throw new Error('escalateToHuman function not found in source')
  return match[0]
}

describe('escalateToHuman — reset to main before branching skip-list PR', () => {
  it('exists as an async function in index.ts', () => {
    expect(source).toMatch(/async function escalateToHuman\(/)
  })

  it('calls resetToMain before creating the fix-bot-skip branch', () => {
    // The load-bearing assertion: reset happens BEFORE `git checkout -b
    // fix-bot-skip/...` so the skip-list PR branches from clean main,
    // not from Agent A's fix/issue-N branch with the failing test +
    // attempted fix commits.
    const body = escalateBody()
    const resetIdx = body.search(/resetToMain\s*\(/)
    const checkoutBIdx = body.search(/['"]checkout['"]\s*,\s*['"]-b['"]\s*,\s*skipBranch/)
    expect(resetIdx, 'resetToMain call must exist inside escalateToHuman').toBeGreaterThan(-1)
    expect(checkoutBIdx, 'git checkout -b skipBranch must exist inside escalateToHuman').toBeGreaterThan(-1)
    expect(resetIdx).toBeLessThan(checkoutBIdx)
  })

  it('resets to main using the branch name in scope (not a hardcoded string)', () => {
    // The reset must clean up whatever branch this attempt used. The
    // orchestrator passes the issue-specific `branchName` (e.g. fix/issue-42)
    // in as a parameter; escalateToHuman must forward it so the branch
    // gets deleted along with the reset. Hardcoding 'main' or a made-up
    // name would leave fix/issue-N behind for the next cron.
    const body = escalateBody()
    expect(body).toMatch(/resetToMain\s*\(\s*branchName\s*,/)
  })
})
