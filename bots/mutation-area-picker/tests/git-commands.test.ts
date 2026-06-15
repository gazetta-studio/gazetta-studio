/**
 * Pins the deterministic-branch-start contract for the
 * mutation-area-picker bot's PR-opening flow.
 *
 * Per team-preferences rule 38 (audit symmetric bots when fixing a
 * pattern bug): the same bug that bit #550 in feature-bot — a leftover
 * remote branch of the deterministic name carrying stale commits into a
 * fresh PR — applies here too. mutation-area-picker's branch name
 * (`mutation-scope/{date}-{action}`) repeats every time the same date +
 * action recurs, so a re-run on the same day OR a workflow runner whose
 * local checkout is dirty would reuse the stale leftover.
 *
 * Mirror of feature-bot's `pushBranch` + Agent A's `checkout -B
 * $BRANCH origin/main` pattern.
 */
import { describe, expect, it } from 'vitest'
import { scopeChangeGitCommands } from '../git-commands.js'

describe('scopeChangeGitCommands', () => {
  it('checks out via `-B` (create-or-reset) starting from origin/main', () => {
    const { checkoutArgs } = scopeChangeGitCommands('mutation-scope/2026-06-15-add')

    // `-B` creates-or-resets; combined with `origin/main` it discards
    // any local OR remote stale state on the named branch. `-b` would
    // FAIL if the branch already existed locally — the wrong tool.
    expect(checkoutArgs).toContain('-B')
    expect(checkoutArgs).not.toContain('-b')

    // Must start from origin/main (NOT current HEAD). The runner's
    // local checkout may have leftover commits from a prior cron run
    // or operator inspection.
    expect(checkoutArgs).toContain('origin/main')
  })

  it('pushes via `--force-with-lease` (NOT `--force`)', () => {
    const { pushArgs } = scopeChangeGitCommands('mutation-scope/2026-06-15-add')

    // Force-with-lease is safe (rejects clobbering an unexpected
    // upstream); plain --force is destructive.
    expect(pushArgs).toContain('--force-with-lease')
    expect(pushArgs).not.toContain('--force')
  })

  it('targets the passed branch on both checkout and push', () => {
    const branch = 'mutation-scope/2026-06-15-swap'

    const { checkoutArgs, pushArgs } = scopeChangeGitCommands(branch)

    expect(checkoutArgs).toContain(branch)
    expect(pushArgs).toContain(branch)
  })

  it('sets upstream on push so subsequent operations track the remote branch', () => {
    const { pushArgs } = scopeChangeGitCommands('mutation-scope/2026-06-15-remove')

    // `-u` sets upstream so the operator's `gh pr create` (and any
    // follow-up `git push`) tracks the remote branch.
    expect(pushArgs).toContain('-u')
    expect(pushArgs).toContain('origin')
  })
})
