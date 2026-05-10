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

export interface IssueSummary {
  number: number
  title: string
  labels: string[]
  /** ISO-8601 timestamp of issue creation. */
  createdAt: string
  /** Issue author's login (null for ghost / deleted users). */
  authorLogin: string | null
}

/**
 * List open issues that are candidates for triage: anything labeled
 * `needs-triage` OR with no labels at all (newly filed, never touched).
 *
 * Excludes pull requests — Octokit returns PRs in this endpoint by default
 * because GitHub treats them as a kind of issue. Filtered out here.
 *
 * Bot scope: any issue this returns is fair game for the triage bot to
 * enrich. Issues already past `needs-triage` (e.g. labeled `ready-for-agent`,
 * `wontfix`) are not returned and not bot-touched.
 */
export async function findTriageCandidates(octokit: Octokit, repo: RepoIdentity): Promise<IssueSummary[]> {
  // Two queries — one for the explicit label, one for unlabeled. We dedup by
  // issue number in case some race produces both. Octokit pagination defaults
  // to 30; we ask for 100 because daily triage volume is small but we'd
  // rather catch a backlog than silently truncate.
  const labelled = await octokit.issues.listForRepo({
    ...repo,
    state: 'open',
    labels: 'needs-triage',
    per_page: 100,
  })

  // GitHub doesn't have a server-side "no labels" filter; fetch all open and
  // filter client-side. Bounded by total open issue count, which is small for
  // any project where a daily triage bot makes sense.
  const allOpen = await octokit.issues.listForRepo({
    ...repo,
    state: 'open',
    per_page: 100,
  })
  const unlabelled = allOpen.data.filter(i => i.labels.length === 0)

  const seen = new Set<number>()
  const out: IssueSummary[] = []
  for (const issue of [...labelled.data, ...unlabelled]) {
    if (issue.pull_request) continue // skip PRs
    if (seen.has(issue.number)) continue
    seen.add(issue.number)
    out.push({
      number: issue.number,
      title: issue.title,
      labels: issue.labels.map(l => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean),
      createdAt: issue.created_at,
      authorLogin: issue.user?.login ?? null,
    })
  }
  return out
}
