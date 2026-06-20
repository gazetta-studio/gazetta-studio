/**
 * Coverage-shape tests for `bots/_lib/git-tree.ts`.
 *
 * git-tree.ts carries load-bearing defensive try/catch handling for the
 * generator-critic loop's "reset to clean main" step. Without these
 * defensive paths, the orchestrator would crash on the common case
 * (first attempt = no branch to delete) and on the documented "Agent A
 * committed nothing" detection.
 *
 * The module shells out via `execFileSync`, so the tests mock
 * `node:child_process` per the pattern in
 * `packages/gazetta/tests/e2e-rm-safe.test.ts`. Each test asserts what
 * the module's JSDoc promises about its public surface; the
 * counterfactuals below name the concrete mutation each test would
 * catch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}))

import { execFileSync } from 'node:child_process'
import { branchHasCommits, captureCommitMessages, captureDiff, resetToMain } from '../git-tree.js'

const mockExec = vi.mocked(execFileSync)
const OPTS = { cwd: '/repo' }

beforeEach(() => {
  mockExec.mockReset()
})
afterEach(() => {
  vi.clearAllMocks()
})

describe('branchHasCommits', () => {
  // Counterfactual: if the success path didn't parse stdout, or parsed
  // it wrong (e.g. dropped the leading character), a commit-count of
  // "5" would be misread and the function would return false. Catches
  // a regression that breaks the orchestrator's "Agent A made changes"
  // path.
  it('returns true when the branch has commits beyond main (parsed count > 0)', () => {
    mockExec.mockReturnValueOnce('5\n' as unknown as Buffer)

    expect(branchHasCommits('improve/foo', OPTS)).toBe(true)

    expect(mockExec).toHaveBeenCalledTimes(1)
    const [bin, args, opts] = mockExec.mock.calls[0]
    expect(bin).toBe('git')
    expect(args).toEqual(['rev-list', '--count', 'main..improve/foo'])
    expect((opts as { cwd: string }).cwd).toBe('/repo')
  })

  // Counterfactual: if the threshold comparison was `>= 0` instead of
  // `> 0`, this test would return true and break the "Agent A
  // committed nothing → SKIP" detection (the original docstring use
  // case). The 0-case is the load-bearing boundary.
  it('returns false when the branch has zero commits beyond main', () => {
    mockExec.mockReturnValueOnce('0\n' as unknown as Buffer)

    expect(branchHasCommits('improve/foo', OPTS)).toBe(false)
  })

  // Counterfactual: if the try/catch around `git rev-list` was
  // removed, `branchHasCommits` would throw on a missing branch
  // instead of returning false. The orchestrator relies on the
  // false return — without it, the bot would crash whenever Agent A
  // creates a branch name typo or fails before committing anything.
  it('returns false when git rev-list throws (missing branch / defensive)', () => {
    mockExec.mockImplementationOnce(() => {
      throw new Error("fatal: ambiguous argument 'main..improve/foo'")
    })

    expect(branchHasCommits('improve/foo', OPTS)).toBe(false)
  })
})

describe('captureDiff', () => {
  // Counterfactual: if the success path threw away git's output (e.g.
  // a refactor that captures stderr instead of stdout, or that calls
  // `.trim()` on a non-string), reviewer agent input would be empty
  // and APPROVE/REJECT decisions would happen blind. The string
  // round-trip pins the contract.
  it('returns the unified diff when git diff succeeds', () => {
    const diff = 'diff --git a/foo b/foo\n--- a/foo\n+++ b/foo\n@@ -1 +1 @@\n-old\n+new\n'
    mockExec.mockReturnValueOnce(diff as unknown as Buffer)

    expect(captureDiff('improve/foo', OPTS)).toBe(diff)

    const [, args] = mockExec.mock.calls[0]
    // The `main...branch` triple-dot syntax is load-bearing for the
    // reviewer (shows changes on the branch, not the union with main's
    // moving HEAD). A future refactor to `main..branch` would surface
    // the wrong diff; pinning the arg shape catches it.
    expect(args).toEqual(['diff', 'main...improve/foo'])
  })

  // Counterfactual: if the try/catch around `git diff` was removed,
  // captureDiff would throw on a missing branch. The orchestrator
  // relies on the empty-string return (per the docstring: "Agent A's
  // attempt produced no diff — usually means it picked a SKIP path").
  it('returns empty string when git diff throws (missing branch / defensive)', () => {
    mockExec.mockImplementationOnce(() => {
      throw new Error("fatal: unknown revision 'main...improve/nope'")
    })

    expect(captureDiff('improve/nope', OPTS)).toBe('')
  })
})

describe('captureCommitMessages', () => {
  // Counterfactual: if `.trim()` was dropped, the trailing
  // `---\n` separator + newline would leak into the reviewer prompt;
  // the comparison would surface that. (The docstring promises
  // "messages relative to main" — trailing whitespace is noise the
  // function explicitly strips.)
  it('returns trimmed log output when git log succeeds', () => {
    const raw = 'fix: first commit\n---\nfix: second commit\n---\n'
    mockExec.mockReturnValueOnce(raw as unknown as Buffer)

    expect(captureCommitMessages('improve/foo', OPTS)).toBe('fix: first commit\n---\nfix: second commit\n---')

    const [, args] = mockExec.mock.calls[0]
    // The `main..branch` double-dot syntax is load-bearing here (lists
    // commits unique to the branch, not the merge-base symmetric set
    // that triple-dot would yield). A refactor to `main...branch`
    // would silently include commits already on main if the branch is
    // out of date.
    expect(args).toEqual(['log', 'main..improve/foo', '--format=%B%n---'])
  })

  // Counterfactual: same shape as captureDiff — without the try/catch,
  // a missing branch crashes the orchestrator instead of falling back
  // to "no commit messages available."
  it('returns empty string when git log throws (missing branch / defensive)', () => {
    mockExec.mockImplementationOnce(() => {
      throw new Error("fatal: unknown revision 'improve/nope'")
    })

    expect(captureCommitMessages('improve/nope', OPTS)).toBe('')
  })
})

describe('resetToMain', () => {
  // Counterfactual: if any of the three mandatory commands (reset
  // --hard, clean -fd, checkout main) was dropped, the orchestrator's
  // "fresh start" contract breaks. Asserting that all three fire AND
  // in this order pins the "discard uncommitted changes BEFORE
  // switching branches" invariant.
  it('runs reset --hard, clean -fd, checkout main in order, then branch -D', () => {
    mockExec.mockReturnValue(undefined as unknown as Buffer)

    resetToMain('improve/foo', OPTS)

    expect(mockExec).toHaveBeenCalledTimes(4)

    expect(mockExec.mock.calls[0][0]).toBe('git')
    expect(mockExec.mock.calls[0][1]).toEqual(['reset', '--hard', 'HEAD'])

    expect(mockExec.mock.calls[1][0]).toBe('git')
    expect(mockExec.mock.calls[1][1]).toEqual(['clean', '-fd'])

    expect(mockExec.mock.calls[2][0]).toBe('git')
    expect(mockExec.mock.calls[2][1]).toEqual(['checkout', 'main'])

    expect(mockExec.mock.calls[3][0]).toBe('git')
    expect(mockExec.mock.calls[3][1]).toEqual(['branch', '-D', 'improve/foo'])
  })

  // Counterfactual: if the try/catch around `git branch -D` was
  // removed, resetToMain would throw on the FIRST attempt of every
  // finding (the branch never exists yet). The "idempotent" promise
  // in the docstring depends on this catch.
  it('swallows branch -D failure when the branch does not exist (idempotent)', () => {
    // Make `branch -D` (the 4th call) throw; the prior three succeed.
    mockExec
      .mockReturnValueOnce(undefined as unknown as Buffer) // reset
      .mockReturnValueOnce(undefined as unknown as Buffer) // clean
      .mockReturnValueOnce(undefined as unknown as Buffer) // checkout
      .mockImplementationOnce(() => {
        throw new Error("error: branch 'improve/nope' not found.")
      })

    expect(() => resetToMain('improve/nope', OPTS)).not.toThrow()
    expect(mockExec).toHaveBeenCalledTimes(4)
  })

  // Counterfactual: if a try/catch crept around the `run()` helper
  // (e.g. someone copy-pasted the defensive pattern from
  // `git branch -D` to the other three calls), a `checkout main` that
  // failed because the working tree was dirty would be silently
  // swallowed and resetToMain would return "successfully" without
  // ever switching branches — leaving Agent A's next attempt on the
  // old branch. The reset/clean/checkout failures MUST surface.
  it('does NOT swallow failures from reset/clean/checkout (only branch -D is best-effort)', () => {
    mockExec.mockImplementationOnce(() => {
      throw new Error('fatal: cannot reset; uncommitted merge in progress')
    })

    expect(() => resetToMain('improve/foo', OPTS)).toThrow(/cannot reset/)
    // Bailed at the first call; never reached clean / checkout /
    // branch -D.
    expect(mockExec).toHaveBeenCalledTimes(1)
  })

  // Counterfactual: if the branch -D call leaked stderr through to
  // the parent process, workflow logs would carry alarming
  // "branch 'X' not found" lines on every first attempt (the
  // motivation called out in the source's docblock). The
  // `stdio: ['ignore', 'ignore', 'ignore']` option is the contract;
  // a refactor that swaps to `stdio: 'inherit'` would re-introduce
  // the noise.
  it('passes stdio: [ignore, ignore, ignore] to branch -D (suppresses stderr)', () => {
    mockExec.mockReturnValue(undefined as unknown as Buffer)

    resetToMain('improve/foo', OPTS)

    const [, , opts] = mockExec.mock.calls[3]
    expect((opts as { stdio: unknown[] }).stdio).toEqual(['ignore', 'ignore', 'ignore'])
  })
})
