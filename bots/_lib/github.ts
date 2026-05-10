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
 * State roles that indicate an issue has been advanced past the triage bot's
 * scope. The bot enriches; humans decide. Any issue carrying one of these
 * has had a maintainer judgment applied — bot stays out.
 *
 * Mirrors the five state roles from the `/triage` skill
 * (~/.claude/skills/triage/SKILL.md). `needs-triage` is intentionally NOT
 * in this list — it's the bot's "default state" and the bot may re-enrich
 * issues sitting there.
 */
const ADVANCED_STATE_ROLES = ['needs-info', 'ready-for-agent', 'ready-for-human', 'wontfix'] as const

/**
 * List open issues the triage bot may enrich.
 *
 * Scope: every open issue that has NOT been advanced past `needs-triage` by
 * a maintainer. Concretely, any open issue lacking ALL of `needs-info`,
 * `ready-for-agent`, `ready-for-human`, `wontfix`. Includes:
 *
 *   - Unlabeled issues (newly filed, never touched)
 *   - Issues labeled `needs-triage` (the bot's primary surface)
 *   - Issues partially labeled by maintainers (`bug` only, `area: cms` only,
 *     `flake` only, etc.) but never advanced past triage
 *
 * Excludes pull requests — Octokit returns PRs in this endpoint by default
 * because GitHub treats them as a kind of issue. Filtered out here.
 *
 * Per-issue dedup (skip if the bot has already enriched and has no new
 * findings) lives in the bot's prompt, not here. This function is intent-
 * neutral — it returns every candidate that's ever eligible.
 */
export async function findTriageCandidates(octokit: Octokit, repo: RepoIdentity): Promise<IssueSummary[]> {
  // GitHub's REST API has no native "lacks ALL of these labels" filter, so
  // fetch all open issues and filter client-side. Bounded by total open issue
  // count, which is small for any project where a daily triage bot makes sense.
  const { data } = await octokit.issues.listForRepo({
    ...repo,
    state: 'open',
    per_page: 100,
  })

  const out: IssueSummary[] = []
  for (const issue of data) {
    if (issue.pull_request) continue // skip PRs
    const labels = issue.labels.map(l => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean)
    if (labels.some(l => (ADVANCED_STATE_ROLES as readonly string[]).includes(l))) continue
    out.push({
      number: issue.number,
      title: issue.title,
      labels,
      createdAt: issue.created_at,
      authorLogin: issue.user?.login ?? null,
    })
  }
  return out
}

/**
 * Detect whether any prior bot comment exists on an issue, by looking for the
 * AI triage disclaimer prefix at the start of any comment body.
 *
 * Returns true when the bot has commented before (subsequent investigation),
 * false when this is the bot's first time on this issue.
 *
 * Pre-computing this at the orchestrator level — instead of asking Claude to
 * fetch + parse comments — saves one tool call per investigation and removes
 * an ambiguity (Claude sometimes counted maintainer comments containing the
 * word "triage" as prior bot output).
 */
export async function hasPriorBotComment(octokit: Octokit, repo: RepoIdentity, issueNumber: number): Promise<boolean> {
  const { data } = await octokit.issues.listComments({
    ...repo,
    issue_number: issueNumber,
    per_page: 100,
  })
  return data.some(c => (c.body ?? '').trimStart().startsWith('> *This was generated by AI during triage.*'))
}
