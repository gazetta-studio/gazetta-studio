import { describe, expect, it, vi } from 'vitest'
import { findFlakeCandidates, findWorkflowId } from '../github.js'

const REPO = { owner: 'gazetta-studio', repo: 'gazetta-studio' }

function makeListRepoWorkflows(workflows: Array<{ id: number; name: string }>) {
  return vi.fn().mockResolvedValue({ data: { workflows } })
}

function makeWorkflowRun(
  over: Partial<{
    id: number
    head_sha: string
    conclusion: string | null
    run_attempt: number | undefined
  }>,
) {
  return {
    id: over.id ?? 1000,
    head_sha: over.head_sha ?? 'abc123',
    conclusion: over.conclusion ?? 'success',
    run_attempt: over.run_attempt,
  }
}

describe('findWorkflowId', () => {
  it('returns the workflow ID for an exact-name match', async () => {
    // Counterfactual: if the impl matched on `path` instead of `name`, or used
    // fuzzy / startsWith matching, the assertion below would fail because
    // `name` is the load-bearing identifier per the JSDoc ("the `name:` field
    // in the YAML").
    const listRepoWorkflows = makeListRepoWorkflows([
      { id: 11, name: 'Other Workflow' },
      { id: 42, name: 'CI' },
      { id: 99, name: 'Mutation' },
    ])
    const octokit = { actions: { listRepoWorkflows } } as never
    expect(await findWorkflowId(octokit, REPO, 'CI')).toBe(42)
  })

  it('throws when no workflow matches the given name', async () => {
    // Counterfactual: if the impl returned `undefined`, `0`, or `-1` on miss
    // instead of throwing, callers using the return value to construct a
    // listWorkflowRuns call would silently issue a garbage request to GitHub.
    // The throw is the contract.
    const listRepoWorkflows = makeListRepoWorkflows([
      { id: 1, name: 'CI' },
      { id: 2, name: 'Deploy' },
    ])
    const octokit = { actions: { listRepoWorkflows } } as never
    await expect(findWorkflowId(octokit, REPO, 'Nonexistent')).rejects.toThrow(/Nonexistent/)
  })

  it('lists the available workflow names in the not-found error to aid debugging', async () => {
    // The error message is documented as part of the function's UX contract:
    // an operator looking at a failing bot needs to see WHAT workflows exist
    // so they can correct the typo without searching the YAML files. Mining
    // the message is what they'll do.
    // Counterfactual: if the impl threw a bare "not found" without the
    // available list, a caller fixing a typo would have to grep the repo for
    // workflow definitions instead of reading the error.
    const listRepoWorkflows = makeListRepoWorkflows([
      { id: 1, name: 'CI' },
      { id: 2, name: 'Deploy' },
    ])
    const octokit = { actions: { listRepoWorkflows } } as never
    let caught: Error | null = null
    try {
      await findWorkflowId(octokit, REPO, 'CIE')
    } catch (err) {
      caught = err as Error
    }
    expect(caught).not.toBeNull()
    expect(caught!.message).toContain('CI')
    expect(caught!.message).toContain('Deploy')
  })

  it('treats name lookups case-sensitively', async () => {
    // GitHub workflow names are case-sensitive in `workflow_dispatch` and in
    // the API. A bot configured with `'ci'` looking for `'CI'` should fail
    // loudly, not silently match the differently-cased workflow.
    // Counterfactual: if the impl used .toLowerCase() comparison, this would
    // resolve to a workflow ID instead of throwing — and a typo'd workflow
    // name would silently target the wrong workflow.
    const listRepoWorkflows = makeListRepoWorkflows([{ id: 7, name: 'CI' }])
    const octokit = { actions: { listRepoWorkflows } } as never
    await expect(findWorkflowId(octokit, REPO, 'ci')).rejects.toThrow(/ci/)
  })
})

describe('findFlakeCandidates', () => {
  it('filters out runs with run_attempt === 1 (no rerun = not a flake signal)', async () => {
    // The whole basis of flake detection per the JSDoc: "A run only gains a
    // second attempt when an earlier attempt failed and someone hit Re-run."
    // First-attempt runs are normal CI activity, never flake candidates.
    // Counterfactual: if the impl skipped the run_attempt filter entirely (or
    // used `> 1` excluding 2, or `>= 1` including everything), this assertion
    // would fail — either by including the run or by including too many.
    const listWorkflowRuns = vi.fn().mockResolvedValue({
      data: {
        workflow_runs: [
          makeWorkflowRun({ id: 100, run_attempt: 1, conclusion: 'failure' }),
          makeWorkflowRun({ id: 200, run_attempt: 1, conclusion: 'success' }),
        ],
      },
    })
    const octokit = { actions: { listWorkflowRuns } } as never
    const result = await findFlakeCandidates(octokit, REPO, 42, '2026-05-01T00:00:00Z')
    expect(result).toEqual([])
  })

  it('includes runs at the run_attempt === 2 boundary', async () => {
    // Boundary condition: 2 is the smallest "had to be re-run" value, and the
    // JSDoc explicitly cites it as the rerun marker.
    // Counterfactual: if the impl used `> 2` (off-by-one), this run would be
    // excluded and the bot would miss every classic single-rerun flake.
    const listWorkflowRuns = vi.fn().mockResolvedValue({
      data: {
        workflow_runs: [makeWorkflowRun({ id: 555, run_attempt: 2, conclusion: 'success' })],
      },
    })
    const octokit = { actions: { listWorkflowRuns } } as never
    const result = await findFlakeCandidates(octokit, REPO, 42, '2026-05-01T00:00:00Z')
    expect(result).toHaveLength(1)
    expect(result[0]?.runId).toBe(555)
  })

  it('includes runs with run_attempt > 2 (multi-rerun flakes)', async () => {
    // The JSDoc says "passed on rerun" and "still failing after rerun" — both
    // are flakes worth investigating, and either may have taken more than two
    // attempts to settle.
    // Counterfactual: if the impl special-cased run_attempt === 2 (rather than
    // `>= 2`), three-attempt flakes would silently slip past the watcher.
    const listWorkflowRuns = vi.fn().mockResolvedValue({
      data: {
        workflow_runs: [makeWorkflowRun({ id: 777, run_attempt: 3, conclusion: 'failure' })],
      },
    })
    const octokit = { actions: { listWorkflowRuns } } as never
    const result = await findFlakeCandidates(octokit, REPO, 42, '2026-05-01T00:00:00Z')
    expect(result).toHaveLength(1)
    expect(result[0]?.runAttempt).toBe(3)
  })

  it('includes both success-on-rerun (classic flake) and still-failing (worse flake) outcomes', async () => {
    // Per JSDoc: "Final conclusion can be either: success → classic flake;
    // failure → worse flake. Both warrant investigation."
    // Counterfactual: if the impl filtered to one conclusion (e.g., only
    // included 'success' on the assumption that "failure means real bug"),
    // the watcher would miss the worse-flake half of its mandate.
    const listWorkflowRuns = vi.fn().mockResolvedValue({
      data: {
        workflow_runs: [
          makeWorkflowRun({ id: 1, run_attempt: 2, conclusion: 'success' }),
          makeWorkflowRun({ id: 2, run_attempt: 2, conclusion: 'failure' }),
        ],
      },
    })
    const octokit = { actions: { listWorkflowRuns } } as never
    const result = await findFlakeCandidates(octokit, REPO, 42, '2026-05-01T00:00:00Z')
    expect(result.map(c => c.conclusion).sort()).toEqual(['failure', 'success'])
  })

  it('drops runs whose run_attempt is undefined (Octokit gap, treat as not-a-flake-signal)', async () => {
    // Octokit's TypeScript type allows run_attempt to be optional. The impl
    // must guard — undefined ≠ 0 ≠ 2; the safe interpretation is "no rerun
    // information; do not classify as flake."
    // Counterfactual: if the impl coerced undefined to 0 or treated the
    // missing field as ">= 2", a flood of normal runs would surface as
    // alleged flakes the moment Octokit returned the field as undefined.
    const listWorkflowRuns = vi.fn().mockResolvedValue({
      data: {
        workflow_runs: [makeWorkflowRun({ id: 999, run_attempt: undefined, conclusion: 'success' })],
      },
    })
    const octokit = { actions: { listWorkflowRuns } } as never
    const result = await findFlakeCandidates(octokit, REPO, 42, '2026-05-01T00:00:00Z')
    expect(result).toEqual([])
  })

  it('maps Octokit run shape to FlakeCandidate field names', async () => {
    // The translation layer that decouples the bot from Octokit's response
    // shape: `id → runId`, `head_sha → headSha`, `run_attempt → runAttempt`,
    // `conclusion → conclusion`. The bots build on these renamed fields; a
    // mapping bug here breaks every downstream consumer.
    // Counterfactual: if the impl returned the raw Octokit shape (snake_case)
    // or mapped to a different field name (e.g., `sha` instead of `headSha`),
    // bots reading `.headSha` would see undefined and silently emit bogus
    // issues with no commit reference.
    const listWorkflowRuns = vi.fn().mockResolvedValue({
      data: {
        workflow_runs: [makeWorkflowRun({ id: 12345, head_sha: 'deadbeef', run_attempt: 2, conclusion: 'success' })],
      },
    })
    const octokit = { actions: { listWorkflowRuns } } as never
    const result = await findFlakeCandidates(octokit, REPO, 42, '2026-05-01T00:00:00Z')
    expect(result[0]).toEqual({
      runId: 12345,
      headSha: 'deadbeef',
      conclusion: 'success',
      runAttempt: 2,
    })
  })

  it('forwards the sinceIso parameter as a `>${sinceIso}` created filter', async () => {
    // The time-window contract: callers pass `sinceIso` to scope to recent
    // runs. The helper builds a GitHub `created=>YYYY-MM-DD...` qualifier —
    // a load-bearing efficiency check (a workflow with thousands of historic
    // runs without this scoping would return a huge response).
    // Counterfactual: if the impl ignored sinceIso (or built the wrong
    // qualifier like `created=YYYY` without the `>` prefix), the API call
    // would either return everything or filter to a single day. Both break
    // the bot's time-window mandate.
    const listWorkflowRuns = vi.fn().mockResolvedValue({ data: { workflow_runs: [] } })
    const octokit = { actions: { listWorkflowRuns } } as never
    await findFlakeCandidates(octokit, REPO, 42, '2026-05-01T00:00:00Z')
    expect(listWorkflowRuns).toHaveBeenCalledTimes(1)
    expect(listWorkflowRuns.mock.calls[0]?.[0]).toMatchObject({
      ...REPO,
      workflow_id: 42,
      created: '>2026-05-01T00:00:00Z',
    })
  })
})
