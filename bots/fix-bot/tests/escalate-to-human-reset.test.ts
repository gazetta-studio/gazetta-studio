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
 * Without resetting before `git checkout -b fix-bot-skip/<date>-issue-N`,
 * the skip-list PR carries Agent A's failing test + attempted fix commits
 * alongside the skip-list update — muddying review + landing unwanted
 * commits on `main` if merged.
 *
 * The 6-step git+gh pipeline was extracted into `openSkipListPR` (see
 * `open-skip-list-pr.ts`) so the reset-first invariant lives in one
 * place. `openSkipListPR`'s own tests
 * (`open-skip-list-pr.test.ts`) assert the reset-first sequence
 * behaviorally against stubbed execFileSync; the tests below assert
 * that `escalateToHuman` routes through the helper AND forwards its
 * own `branchName` param so the fix/issue-N branch gets cleaned up.
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

  it('routes through openSkipListPR (which owns the reset-first sequence)', () => {
    // The reset-first invariant lives in the extracted helper. Verify
    // escalateToHuman actually invokes it — otherwise the extraction
    // would ship as dead code and the inline 6-step pipeline would
    // still be duplicated (rule 18 SRP violation unaddressed).
    const body = escalateBody()
    expect(body).toMatch(/openSkipListPR\s*\(/)
  })

  it('forwards branchName to openSkipListPR so fix/issue-N gets cleaned up', () => {
    // The reset must clean up whatever branch this attempt used. The
    // orchestrator passes the issue-specific `branchName` (e.g. fix/issue-42)
    // in as a parameter; escalateToHuman must forward it via
    // openSkipListPR's `branchName` option so the branch gets deleted
    // along with the reset. Hardcoding 'main' or a made-up name would
    // leave fix/issue-N behind for the next cron.
    const body = escalateBody()
    // Match the shorthand property syntax `branchName,` (or `branchName`
    // followed by newline/whitespace + closing `}`) inside the
    // openSkipListPR call's options object.
    expect(body).toMatch(/openSkipListPR\s*\(\s*\{[\s\S]*?\bbranchName\b\s*[,\n}]/)
  })
})
