/**
 * `openSkipListPR` extracts the 6-step git+gh pipeline (resetToMain →
 * checkout -b → add → commit → push --force-with-lease → gh pr create
 * → checkout main) that `escalateToHuman` and `openPastPRSkipListPR`
 * duplicated inline. The two callers now dispatch through this shared
 * helper; the helper owns the sequence, error handling, and the
 * final "return to main" step.
 *
 * Per team-preferences rule 18 (SRP at file creation): the two
 * functions were written parallel-shape without extraction; this
 * repair moves the shared pipeline into its own file so the shape
 * has a single home (single reason to change: how a skip-list PR
 * gets filed).
 *
 * Tests are behavioral (stubbed execFileSync per the
 * `bots/_lib/tests/git-tree.test.ts` pattern) rather than
 * source-regex — the invariant this pins is a runtime sequence of
 * subprocess calls, not a source substring. Source-regex assertions
 * on order have already tripped over JSDoc mentions of the same
 * symbols; behavioral assertions are immune.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}))

import { execFileSync } from 'node:child_process'
import { openSkipListPR } from '../open-skip-list-pr.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX_PATH = resolve(HERE, '..', 'index.ts')

const mockExec = vi.mocked(execFileSync)

const BASE_OPTS = {
  branchName: 'fix/issue-42',
  skipBranchName: 'fix-bot-skip/2026-06-01-issue-42',
  commitMessage: 'chore(skip-list): record needs-human for #42',
  prTitle: 'chore(skip-list): record needs-human for #42',
  prBody: '> body markdown\n',
  cwd: '/repo',
  skipListPath: 'bots/fix-bot/skip-list.json',
  issueNumber: 42,
}

beforeEach(() => {
  mockExec.mockReset()
  // Default: every subprocess call succeeds and returns nothing.
  mockExec.mockReturnValue(undefined as unknown as Buffer)
})

afterEach(() => {
  vi.clearAllMocks()
})

/**
 * Extracts the body of a top-level function or async function by name
 * via brace matching — same helper shape as
 * `push-force-with-lease.test.ts`. Scopes source-regex assertions to
 * a function's body, excluding the JSDoc header above it (the trap
 * the earlier attempt at this test fell into: `resetToMain` matched
 * inside a JSDoc comment before the actual call in the code).
 */
function extractFunctionBody(src: string, name: string): string {
  const decl = new RegExp(String.raw`(?:async\s+)?function\s+${name}\s*\(`)
  const match = decl.exec(src)
  if (!match) throw new Error(`function ${name} not found in index.ts`)
  const openParen = src.indexOf('(', match.index)
  let depth = 0
  let i = openParen
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')') {
      depth--
      if (depth === 0) {
        i++
        break
      }
    }
  }
  const bodyStart = src.indexOf('{', i)
  depth = 0
  for (let j = bodyStart; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') {
      depth--
      if (depth === 0) return src.slice(bodyStart, j + 1)
    }
  }
  throw new Error(`could not extract body of ${name}`)
}

describe('openSkipListPR (extracted 6-step pipeline)', () => {
  // Counterfactual: without this test, an accidental reorder that
  // pushed before committing (or committed before adding) would slip
  // through — the two inline pipelines each had the correct order
  // by convention, not by contract. Pinning the sequence in the
  // extracted helper makes the contract explicit.
  it('runs resetToMain then the 5-step git+gh pipeline then a final checkout main, in exact order', () => {
    openSkipListPR(BASE_OPTS)

    // resetToMain fires 4 subprocess calls: reset --hard, clean -fd,
    // checkout main, branch -D. Then the try block fires 5 more:
    // checkout -b, add, commit, push, gh pr create. Then the finally
    // block fires 1 more: checkout main. Total = 10.
    expect(mockExec).toHaveBeenCalledTimes(10)

    // Step 0-3: resetToMain phase.
    expect(mockExec.mock.calls[0][0]).toBe('git')
    expect(mockExec.mock.calls[0][1]).toEqual(['reset', '--hard', 'HEAD'])
    expect(mockExec.mock.calls[1][0]).toBe('git')
    expect(mockExec.mock.calls[1][1]).toEqual(['clean', '-fd'])
    expect(mockExec.mock.calls[2][0]).toBe('git')
    expect(mockExec.mock.calls[2][1]).toEqual(['checkout', 'main'])
    expect(mockExec.mock.calls[3][0]).toBe('git')
    expect(mockExec.mock.calls[3][1]).toEqual(['branch', '-D', 'fix/issue-42'])

    // Step 4: checkout -b <skipBranch>.
    expect(mockExec.mock.calls[4][0]).toBe('git')
    expect(mockExec.mock.calls[4][1]).toEqual(['checkout', '-b', 'fix-bot-skip/2026-06-01-issue-42'])

    // Step 5: add <skip-list.json>.
    expect(mockExec.mock.calls[5][0]).toBe('git')
    expect(mockExec.mock.calls[5][1]).toEqual(['add', 'bots/fix-bot/skip-list.json'])

    // Step 6: commit -m <message>.
    expect(mockExec.mock.calls[6][0]).toBe('git')
    expect(mockExec.mock.calls[6][1]).toEqual([
      'commit',
      '-m',
      'chore(skip-list): record needs-human for #42',
    ])

    // Step 7: push -u --force-with-lease origin <skipBranch>. The
    // --force-with-lease flag is load-bearing (see
    // push-force-with-lease.test.ts): a rerun against a stale leftover
    // skip-list branch of the same name would otherwise silently fail.
    expect(mockExec.mock.calls[7][0]).toBe('git')
    expect(mockExec.mock.calls[7][1]).toEqual([
      'push',
      '-u',
      '--force-with-lease',
      'origin',
      'fix-bot-skip/2026-06-01-issue-42',
    ])

    // Step 8: gh pr create --draft --title X --body Y.
    expect(mockExec.mock.calls[8][0]).toBe('gh')
    expect(mockExec.mock.calls[8][1]).toEqual([
      'pr',
      'create',
      '--draft',
      '--title',
      'chore(skip-list): record needs-human for #42',
      '--body',
      '> body markdown\n',
    ])

    // Step 9: finally block — return to main.
    expect(mockExec.mock.calls[9][0]).toBe('git')
    expect(mockExec.mock.calls[9][1]).toEqual(['checkout', 'main'])
  })

  // Counterfactual: if the try/catch was dropped, a gh CLI failure
  // (rate-limit, auth, network) would crash the caller and skip the
  // finally-block `git checkout main` — leaving the working tree on
  // the skip-list branch for the NEXT candidate to inherit.
  it('runs the finally-block checkout main even when gh pr create throws', () => {
    // Fail on the 9th call (gh pr create — index 8). The prior 8 succeed.
    mockExec
      .mockReturnValueOnce(undefined as unknown as Buffer) // reset
      .mockReturnValueOnce(undefined as unknown as Buffer) // clean
      .mockReturnValueOnce(undefined as unknown as Buffer) // checkout main
      .mockReturnValueOnce(undefined as unknown as Buffer) // branch -D
      .mockReturnValueOnce(undefined as unknown as Buffer) // checkout -b
      .mockReturnValueOnce(undefined as unknown as Buffer) // add
      .mockReturnValueOnce(undefined as unknown as Buffer) // commit
      .mockReturnValueOnce(undefined as unknown as Buffer) // push
      .mockImplementationOnce(() => {
        throw new Error('gh: rate limit exceeded')
      })
      // The finally block still fires.
      .mockReturnValueOnce(undefined as unknown as Buffer)

    expect(() => openSkipListPR(BASE_OPTS)).not.toThrow()

    // The final call must be `git checkout main` (finally block).
    const lastCall = mockExec.mock.calls[mockExec.mock.calls.length - 1]
    expect(lastCall[0]).toBe('git')
    expect(lastCall[1]).toEqual(['checkout', 'main'])
  })

  // Counterfactual: if the resetToMain call was dropped, a caller
  // sitting on `fix/issue-N` (with Agent A's failing-test + attempted-
  // fix commits) would branch the skip-list PR off the dirty branch,
  // carrying those commits alongside the skip-list update. This is
  // the exact class of bug the escalateToHuman + openPastPRSkipListPR
  // resetToMain calls fix (see escalate-to-human-reset.test.ts +
  // past-pr-skip-list-reset.test.ts). Ensuring resetToMain is the
  // FIRST subprocess sequence pins the invariant in the extracted
  // helper.
  it('runs resetToMain BEFORE the git checkout -b for the skip-list branch', () => {
    openSkipListPR(BASE_OPTS)

    // resetToMain's first call is `git reset --hard HEAD` (index 0).
    // The checkout -b for the skip-list branch must come AFTER
    // resetToMain's four calls — i.e. at index 4 or later.
    const checkoutBIdx = mockExec.mock.calls.findIndex(
      ([bin, args]) =>
        bin === 'git' &&
        Array.isArray(args) &&
        args[0] === 'checkout' &&
        args[1] === '-b',
    )
    expect(checkoutBIdx).toBeGreaterThanOrEqual(4)

    // Sanity: resetToMain's `reset --hard HEAD` fired at index 0.
    expect(mockExec.mock.calls[0][1]).toEqual(['reset', '--hard', 'HEAD'])
  })
})

describe('index.ts routes both callers through openSkipListPR', () => {
  // Counterfactual: without this test, the extraction could ship as
  // dead code — the helper exists in its own file but neither
  // `escalateToHuman` nor `openPastPRSkipListPR` actually calls it,
  // leaving the duplicated inline pipelines in place. The two
  // function-body checks below prove both callers dispatch through
  // the shared helper.
  const source = readFileSync(INDEX_PATH, 'utf-8')

  it('imports openSkipListPR from ./open-skip-list-pr', () => {
    expect(source).toMatch(
      /import\s+\{[^}]*openSkipListPR[^}]*\}\s+from\s+['"]\.\/open-skip-list-pr/,
    )
  })

  it('escalateToHuman body invokes openSkipListPR', () => {
    const body = extractFunctionBody(source, 'escalateToHuman')
    expect(body).toMatch(/openSkipListPR\s*\(/)
  })

  it('openPastPRSkipListPR body invokes openSkipListPR', () => {
    const body = extractFunctionBody(source, 'openPastPRSkipListPR')
    expect(body).toMatch(/openSkipListPR\s*\(/)
  })

  // Counterfactual: if the extraction is only wired into one caller
  // (say, escalateToHuman) and the other is left inline, the
  // duplication remains and rule 18's SRP violation is unaddressed.
  // The strongest anti-duplication check is: neither caller's body
  // contains an inline `execFileSync('gh', …)` — the gh CLI call
  // that used to live in both callers now lives ONLY inside the
  // extracted helper.
  it('neither escalateToHuman nor openPastPRSkipListPR contains an inline gh subprocess call anymore', () => {
    const escalateBody = extractFunctionBody(source, 'escalateToHuman')
    const pastBody = extractFunctionBody(source, 'openPastPRSkipListPR')
    expect(escalateBody).not.toMatch(/execFileSync\(\s*['"]gh['"]/)
    expect(pastBody).not.toMatch(/execFileSync\(\s*['"]gh['"]/)
  })
})
