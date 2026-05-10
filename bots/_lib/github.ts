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
 * re-investigation scope. Any issue carrying one of these is excluded from
 * future bot scans:
 *
 *   - `needs-info` / `ready-for-human` / `wontfix` — applied by maintainer
 *     via the `/triage` skill; bot stays out
 *   - `ready-for-agent` — may be applied by the maintainer OR by the bot
 *     itself (per prompt step 8e auto-advance). Either way, the next bot
 *     surface is fix-bot, not re-triage. Triage-bot stays out.
 *
 * Mirrors the five state roles from the `/triage` skill
 * (~/.claude/skills/triage/SKILL.md). `needs-triage` is intentionally NOT
 * in this list — that label is reserved for the skill-canonical
 * "no bot or human has looked yet" state, distinct from `triage-uncertain`
 * (bot looked, couldn't classify).
 */
/**
 * List open issues matching label-driven criteria.
 *
 * Each bot in the pipeline declares its input as "issues with ALL of
 * `requireAll` AND NONE of `excludeAny`." This is the universal contract
 * — pipeline state lives in labels, not in code or transcripts.
 *
 * Concrete bot inputs:
 *
 *   triage-bot:
 *     requireAll: []
 *     excludeAny: ['bug', 'enhancement', 'triage-uncertain',
 *                  'ready-for-agent', 'ready-for-human',
 *                  'wontfix', 'needs-info']
 *     (no classification yet AND no state advancement)
 *
 *   discovery-prep-bot:
 *     requireAll: ['enhancement']
 *     excludeAny: ['ready-for-human', 'ready-for-agent',
 *                  'wontfix', 'needs-info']
 *     (an enhancement that hasn't been handed off downstream)
 *
 *   fix-bot:
 *     requireAll: ['bug', 'ready-for-agent']
 *     excludeAny: ['wontfix', 'needs-info', 'ready-for-human']
 *     (a bug ready for an agent, no maintainer escalation in flight)
 *
 * Excludes pull requests — Octokit returns PRs in this endpoint by default
 * because GitHub treats them as a kind of issue. Filtered out here.
 *
 * No since-filter: the label-driven exclude-set already narrows candidates
 * to "issues that need work this run." Re-checking already-processed
 * issues at the API level is cheap (one bounded list call per cron); the
 * since-filter would save ~30s per cron at the cost of a stranded-backlog
 * failure mode. Not worth the complexity. Maintainer who wants to
 * re-enqueue an issue removes its completion label — the next cron picks
 * it up because the exclude-set no longer matches.
 */
export async function findIssuesByLabels(
  octokit: Octokit,
  repo: RepoIdentity,
  options: { requireAll?: readonly string[]; excludeAny: readonly string[] },
): Promise<IssueSummary[]> {
  const requireAll = options.requireAll ?? []
  const { data } = await octokit.issues.listForRepo({
    ...repo,
    state: 'open',
    per_page: 100,
    // Server-side prefilter when at least one required label exists. Octokit
    // takes a comma-separated string. Issues here have ALL of these labels
    // (intersection), which matches our requireAll semantics.
    ...(requireAll.length > 0 ? { labels: requireAll.join(',') } : {}),
  })

  const out: IssueSummary[] = []
  for (const issue of data) {
    if (issue.pull_request) continue // skip PRs
    const labels = issue.labels.map(l => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean)
    if (labels.some(l => (options.excludeAny as readonly string[]).includes(l))) continue
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

/**
 * Detect whether a SPECIFIC bot has commented on an issue, by looking for
 * its outcome tag (`<!-- <bot-name>: run=...) in any comment body.
 *
 * Used by triage-bot to decide whether to chain-dispatch a downstream bot
 * (e.g., discovery-prep-bot) — if the downstream bot has already
 * commented on this issue, dispatching again is a wasted run.
 *
 * Different from `hasPriorBotComment` (which detects any AI triage
 * activity via the disclaimer prefix). This one is bot-specific.
 *
 * Caller can pre-fetch the comments and reuse via the comments parameter
 * to avoid duplicate API calls when checking multiple bots' tags on the
 * same issue.
 */
export async function hasPriorCommentFromBot(
  octokit: Octokit,
  repo: RepoIdentity,
  issueNumber: number,
  botName: string,
  comments?: Array<{ body?: string | null }>,
): Promise<boolean> {
  const tag = `<!-- ${botName}: run=`
  if (comments) {
    return comments.some(c => (c.body ?? '').includes(tag))
  }
  const { data } = await octokit.issues.listComments({
    ...repo,
    issue_number: issueNumber,
    per_page: 100,
  })
  return data.some(c => (c.body ?? '').includes(tag))
}

/**
 * Apply a label to an issue. Idempotent — adding an already-present label
 * is a no-op on the GitHub side.
 *
 * Used by bots to mark pipeline progress: e.g., discovery-prep-bot adds
 * `ready-for-human` to signal "research done, maintainer's grilling phase
 * starts now."
 */
export async function addLabel(
  octokit: Octokit,
  repo: RepoIdentity,
  issueNumber: number,
  label: string,
): Promise<void> {
  await octokit.issues.addLabels({
    ...repo,
    issue_number: issueNumber,
    labels: [label],
  })
}
