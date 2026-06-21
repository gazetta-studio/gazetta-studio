import { describe, expect, it, vi } from 'vitest'
import { findFlakeCandidates } from '../github.js'

const REPO = { owner: 'gazetta-studio', repo: 'gazetta-studio' }
const WORKFLOW_ID = 12345
const SINCE = '2026-05-01T00:00:00Z'

function makeRun(overrides: { id: number; run_attempt?: number; conclusion?: string | null; head_sha?: string }) {
  return {
    id: overrides.id,
    head_sha: overrides.head_sha ?? `sha-${overrides.id}`,
    conclusion: overrides.conclusion ?? 'success',
    run_attempt: overrides.run_attempt,
  }
}

function makeOctokit(runs: Array<ReturnType<typeof makeRun>>) {
  const listWorkflowRuns = vi.fn().mockResolvedValue({ data: { workflow_runs: runs } })
  return {
    octokit: { actions: { listWorkflowRuns } } as never,
    listWorkflowRuns,
  }
}

describe('findFlakeCandidates', () => {
  // Counterfactual: would fail if the impl returned all runs (no filter) or used a different threshold
  // such as `>= 3` or `> 2`. The JSDoc names `run_attempt >= 2` as the unambiguous flake signal — a run
  // only gains a second attempt when an earlier attempt failed and someone hit "Re-run", so attempt 2+
  // is exactly the "intermittent failure" set.
  it('returns only runs with run_attempt >= 2', async () => {
    const { octokit } = makeOctokit([
      makeRun({ id: 1, run_attempt: 1 }), // fresh run, not a flake candidate
      makeRun({ id: 2, run_attempt: 2 }), // retried once — flake candidate
      makeRun({ id: 3, run_attempt: 3 }), // retried twice — also a flake candidate
    ])

    const result = await findFlakeCandidates(octokit, REPO, WORKFLOW_ID, SINCE)

    expect(result.map(r => r.runId)).toEqual([2, 3])
  })

  // Counterfactual: would fail if the impl filtered by conclusion. The JSDoc explicitly calls out that
  // BOTH outcomes warrant investigation: success-on-retry is the classic flake, failure-on-retry is the
  // worse flake (still broken after rerun).
  it('includes both success and failure conclusions', async () => {
    const { octokit } = makeOctokit([
      makeRun({ id: 1, run_attempt: 2, conclusion: 'success' }),
      makeRun({ id: 2, run_attempt: 2, conclusion: 'failure' }),
      makeRun({ id: 3, run_attempt: 2, conclusion: 'cancelled' }),
    ])

    const result = await findFlakeCandidates(octokit, REPO, WORKFLOW_ID, SINCE)

    expect(result).toHaveLength(3)
    expect(result.map(r => r.conclusion).sort()).toEqual(['cancelled', 'failure', 'success'])
  })

  // Counterfactual: would fail if the impl didn't check for `run_attempt !== undefined`. Octokit's
  // workflow_runs response can omit run_attempt on older runs; a naive `>=` comparison against undefined
  // is always false in JS but the explicit check guards against future shape changes.
  it('excludes runs with run_attempt undefined', async () => {
    const { octokit } = makeOctokit([makeRun({ id: 1, run_attempt: undefined }), makeRun({ id: 2, run_attempt: 2 })])

    const result = await findFlakeCandidates(octokit, REPO, WORKFLOW_ID, SINCE)

    expect(result.map(r => r.runId)).toEqual([2])
  })

  // Counterfactual: would fail if the impl returned the raw Octokit shape (`head_sha` instead of
  // `headSha`, no `runAttempt`/`runId` aliasing). The FlakeCandidate type is the contract callers depend
  // on — flake-watcher's downstream code reads `.runId` and `.headSha`, not `.id` / `.head_sha`.
  it('maps the Octokit shape to FlakeCandidate fields', async () => {
    const { octokit } = makeOctokit([makeRun({ id: 42, run_attempt: 3, conclusion: 'failure', head_sha: 'deadbeef' })])

    const result = await findFlakeCandidates(octokit, REPO, WORKFLOW_ID, SINCE)

    expect(result).toEqual([
      {
        runId: 42,
        headSha: 'deadbeef',
        conclusion: 'failure',
        runAttempt: 3,
      },
    ])
  })

  // Counterfactual: would fail if the impl forgot to pass `created: >${sinceIso}`. The since-filter is
  // what bounds the API cost — without it the helper would fetch the full workflow-run history every
  // cron tick. flake-watcher's per-cron budget depends on this.
  it('passes sinceIso as a `created: >${sinceIso}` filter to the API', async () => {
    const { octokit, listWorkflowRuns } = makeOctokit([])

    await findFlakeCandidates(octokit, REPO, WORKFLOW_ID, SINCE)

    expect(listWorkflowRuns).toHaveBeenCalledTimes(1)
    expect(listWorkflowRuns.mock.calls[0]?.[0]).toMatchObject({
      owner: 'gazetta-studio',
      repo: 'gazetta-studio',
      workflow_id: WORKFLOW_ID,
      created: `>${SINCE}`,
    })
  })

  // Counterfactual: would fail if the impl returned a non-empty stub (e.g. seeded data). Empty input
  // must produce empty output — the trivial-but-load-bearing case for flake-watcher's "no flakes this
  // window" exit path.
  it('returns an empty array when no runs match', async () => {
    const { octokit } = makeOctokit([])
    const result = await findFlakeCandidates(octokit, REPO, WORKFLOW_ID, SINCE)
    expect(result).toEqual([])
  })
})
