/**
 * Git command-argument helpers for the mutation-area-picker bot's
 * PR-opening flow.
 *
 * Per team-preferences rule 38: mirrors the deterministic-branch-start
 * pattern feature-bot (`feat/cut-NNN`) and review-bot (`improve/<id>`)
 * use to defeat #550-class stale-branch reuse. mutation-area-picker's
 * deterministic branch name (`mutation-scope/{date}-{action}`) repeats
 * whenever the same date + action recurs OR the runner's local
 * checkout carries a leftover branch — both build it from a clean
 * `origin/main` and push with `--force-with-lease`, never `--force`.
 */
export interface ScopeChangeGitCommands {
  /** Args for `git checkout` — creates-or-resets the branch off origin/main. */
  checkoutArgs: readonly string[]
  /** Args for `git push` — sets upstream + force-with-lease against any stale remote. */
  pushArgs: readonly string[]
}

export function scopeChangeGitCommands(branchName: string): ScopeChangeGitCommands {
  return {
    checkoutArgs: ['checkout', '-B', branchName, 'origin/main'],
    pushArgs: ['push', '-u', 'origin', branchName, '--force-with-lease'],
  }
}
