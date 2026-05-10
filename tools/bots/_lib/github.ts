/**
 * GitHub API helpers for bots.
 *
 * Wraps Octokit with the conventions our bots need: workflow lookup by name,
 * flake detection by run_attempt, repo identity from env. All bots running
 * in GitHub Actions inherit GITHUB_REPOSITORY (`owner/repo`) and GH_TOKEN
 * from the workflow env — no config object needed.
 */
import { Octokit } from '@octokit/rest'

export interface RepoIdentity {
  owner: string
  repo: string
}

export interface FlakeCandidate {
  runId: number
  headSha: string
  conclusion: 'success' | 'failure' | 'cancelled' | null
  runAttempt: number
}

/** Resolve owner/repo from GITHUB_REPOSITORY (set by Actions). */
export function repoFromEnv(): RepoIdentity {
  const slug = process.env.GITHUB_REPOSITORY
  if (!slug) throw new Error('GITHUB_REPOSITORY env var is not set')
  const [owner, repo] = slug.split('/')
  if (!owner || !repo) throw new Error(`Invalid GITHUB_REPOSITORY: ${slug}`)
  return { owner, repo }
}

/** Construct an Octokit instance from GH_TOKEN. */
export function octokitFromEnv(): Octokit {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
  if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN env var is required')
  return new Octokit({ auth: token })
}

/** Look up a workflow ID by its display name (the `name:` field in the YAML). */
export async function findWorkflowId(octokit: Octokit, repo: RepoIdentity, workflowName: string): Promise<number> {
  const { data } = await octokit.actions.listRepoWorkflows({ ...repo, per_page: 100 })
  const workflow = data.workflows.find(w => w.name === workflowName)
  if (!workflow) {
    const available = data.workflows.map(w => w.name).join(', ')
    throw new Error(`Workflow "${workflowName}" not found. Available: ${available}`)
  }
  return workflow.id
}

/**
 * Find flake candidates: runs with `run_attempt >= 2` in the time window.
 *
 * A run only gains a second attempt when an earlier attempt failed and
 * someone hit "Re-run". Same code, different outcome — unambiguous flake
 * signal. Final conclusion can be either:
 *   - success → classic flake (passed on rerun)
 *   - failure → worse flake (still failing after rerun)
 * Both warrant investigation.
 */
export async function findFlakeCandidates(
  octokit: Octokit,
  repo: RepoIdentity,
  workflowId: number,
  sinceIso: string,
): Promise<FlakeCandidate[]> {
  const { data } = await octokit.actions.listWorkflowRuns({
    ...repo,
    workflow_id: workflowId,
    per_page: 100,
    created: `>${sinceIso}`,
  })

  return data.workflow_runs
    .filter(run => run.run_attempt !== undefined && run.run_attempt >= 2)
    .map(run => ({
      runId: run.id,
      headSha: run.head_sha,
      conclusion: run.conclusion as FlakeCandidate['conclusion'],
      runAttempt: run.run_attempt!,
    }))
}
