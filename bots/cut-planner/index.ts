/**
 * cut-planner — owns the per-feature cut pipeline.
 *
 * Peer to feature-bot, not above it. feature-bot implements cuts;
 * cut-planner decides WHICH cut is next and HOW it is specified. They
 * communicate through GitHub labels and comments only — neither imports
 * the other.
 *
 * Design: .claude/rules/design-cut-planner.md
 *
 * # Shape
 *
 * index.ts (this file) does discovery + wiring; `dispatch-run.ts` decides the
 * one action; `execute.ts` carries it out through two ports (GitHub, Claude)
 * whose real implementations live in `adapters.ts`. `DRY_RUN=1` reports the
 * decision without executing it.
 *
 * # Input contract
 *
 * The planner issue, and nothing else (design-cut-planner.md open-Q 4).
 * cut-planner never reads a design doc or an impl doc; seeding is
 * maintainer work. A planner issue is an open `enhancement` issue without
 * `ready-for-agent` (so feature-bot ignores it) that `issue-index.ts`
 * classifies structurally — see there for why a cut in `needs-refinement`
 * must never be mistaken for one.
 *
 * # Escalation
 *
 * One rule (Q6a): if cut-planner cannot complete the job, it files for a
 * human. No silent skip, no retry-forever, no undefined state. Two scopes
 * — feature-blocked (`needs-info` on the planner issue, stop filing for
 * that feature) and cut-blocked (`ready-for-human` on the cut, the rest of
 * the feature continues). A quota failure is NOT an inability: rate limits
 * mean "come back later", so the queue stops and nothing is labelled.
 */
import { octokitFromEnv, repoFromEnv, type RepoIdentity } from '../_lib/github.js'
import { printBanner, printCandidateList, printNotice, printRunSummary, printWarning } from '../_lib/ui.js'
import { claudePlanner, loadTemplates, octokitGitHub } from './adapters.js'
import { dispatchRun, type RunDecision } from './dispatch-run.js'
import { escalateMalformedPlanner, executeSafely, type GitHubPort } from './execute.js'
import { classifyIssue, featureOf, type ListedIssue, type ListedPr, observeCuts } from './issue-index.js'
import { countMarked, redecomposedMarker } from './markers.js'
import { parsePlannerIssue } from './planner-issue.js'

const DRY_RUN = process.env.DRY_RUN === '1'
const ONLY_ISSUE = process.env.ISSUE_NUMBER ? Number(process.env.ISSUE_NUMBER) : null
const RUN_ID = process.env.GITHUB_RUN_ID ?? 'local'
const RUN_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-')

/**
 * Per-RUN wall-clock budget. Far smaller than feature-bot's 150 min because
 * cut-planner takes at most ONE action per run (Q5a) and that action is a
 * single Claude call — not a generator-critic loop. Checked before the
 * action starts, never mid-action: a half-done action is worse than none.
 */
const PER_RUN_BUDGET_MS = Number(process.env.BUDGET_MS ?? 30 * 60 * 1000)

/**
 * Spec-refinement budget per cut (design-cut-planner.md Q6). Defaults to 0
 * until Cut 6 ships the refine path — see the design doc's "Arming order".
 */
const MAX_REFINEMENTS = Number(process.env.MAX_REFINEMENTS ?? '0')
/** Re-decomposition budget per feature; the Q6 fallback after refinement. */
const MAX_REDECOMPOSITIONS = Number(process.env.MAX_REDECOMPOSITIONS ?? '1')

/** Labels that take a planner issue out of discovery. `needs-info` = blocked on a human (Q6a). */
const PLANNER_EXCLUDE = ['ready-for-agent', 'ready-for-human', 'wontfix', 'needs-info']

/** One-line, human-readable rendering of a dispatcher decision. */
function describeDecision(d: RunDecision): string {
  switch (d.kind) {
    case 'refine':
      return `refine #${d.issueNumber} (refinement ${d.priorRefinements + 1})`
    case 'redecompose':
      return `re-decompose #${d.issueNumber}`
    case 'escalate-cut':
      return `escalate cut #${d.issueNumber} to a human (${d.reason})`
    case 'escalate-feature':
      return `escalate the feature to a human (${d.reason})`
    case 'file-next':
      return 'file the next cut'
    case 'idle':
      return `nothing to do (${d.because})`
  }
}

async function main(): Promise<void> {
  const repo = repoFromEnv()
  const octokit = octokitFromEnv()
  const gh = octokitGitHub(octokit, repo)
  const startedAt = Date.now()
  const elapsedSec = () => Math.round((Date.now() - startedAt) / 1000)

  printBanner({
    name: 'cut-planner',
    tagline: 'per-feature cut pipeline',
    purpose:
      'File the next cut sub-issue for feature-bot one at a time, and revise a cut spec when the generator-critic loop cannot land it.',
    inputs: [
      'Planner issues: `enhancement` + `**Feature**:` + `**Design**:` / `## State`, without `ready-for-agent`',
      'Refinement queue: cut issues labelled `needs-refinement`',
    ],
    outputs: [
      'At most ONE action per run (Q5a): file a cut, refine one, re-decompose one, or escalate',
      '`needs-info` on the planner issue when a design decision is missing',
    ],
  })

  const [issues, prs] = await Promise.all([listOpenEnhancements(octokit, repo), listOpenPrs(octokit, repo)])
  const planners = issues
    .filter(i => classifyIssue(i.body) === 'planner')
    .filter(i => !i.labels.some(l => PLANNER_EXCLUDE.includes(l)))
    .filter(i => ONLY_ISSUE === null || i.number === ONLY_ISSUE)
    .sort((a, b) => (a.createdAt === b.createdAt ? a.number - b.number : a.createdAt.localeCompare(b.createdAt)))

  if (planners.length === 0) {
    // Absence-as-state per rule 23: nothing to say, so say nothing beyond
    // the run summary. No "nothing to file" comment is ever posted.
    printNotice('No planner issues found. Nothing to do.')
    printRunSummary({ verb: 'Planned', processed: 0, total: 0, skipped: 0, elapsedSec: elapsedSec() })
    return
  }

  printCandidateList({
    noun: 'planner issue',
    candidates: planners.map(p => ({ ref: `#${p.number}`, label: featureOf(p.body) ?? '?', meta: p.title })),
  })

  let processed = 0
  for (const issue of planners) {
    const outcome = await handlePlanner(issue, issues, prs, gh, startedAt)
    if (outcome === 'acted') {
      processed++
      // Q5a: ONE action per run. Each action is several non-transactional
      // writes; capping at one bounds an interrupted run to one feature.
      printNotice('One action taken; stopping (Q5a — one action per run).')
      break
    }
    if (outcome === 'stop') break
  }

  printRunSummary({
    verb: 'Planned',
    processed,
    total: planners.length,
    skipped: planners.length - processed,
    elapsedSec: elapsedSec(),
  })
}

async function handlePlanner(
  issue: ListedIssue,
  issues: readonly ListedIssue[],
  prs: readonly ListedPr[],
  gh: GitHubPort,
  startedAt: number,
): Promise<'acted' | 'idle' | 'stop'> {
  const parsed = parsePlannerIssue(issue.body ?? '')
  if (!parsed.ok) {
    printWarning(`#${issue.number} is a planner issue missing ${parsed.missing.join(' and ')}.`)
    if (DRY_RUN) return 'idle'
    await escalateMalformedPlanner(gh, issue.number, featureOf(issue.body), parsed.missing, RUN_ID)
    return 'acted'
  }
  const planner = parsed.value

  // Comments are only needed for cuts in the refinement queue (their budget)
  // and for the planner itself (the per-feature re-decomposition budget).
  const refining = issues.filter(i => i.labels.includes('needs-refinement') && featureOf(i.body) === planner.feature)
  const commentsByCut = new Map<number, string[]>()
  for (const c of refining) commentsByCut.set(c.number, await gh.listCommentBodies(c.number))
  const plannerComments = await gh.listCommentBodies(issue.number)

  const decision = dispatchRun({
    planner,
    plannerIssueNumber: issue.number,
    cuts: observeCuts(planner.feature, issues, prs, commentsByCut),
    maxRefinements: MAX_REFINEMENTS,
    maxRedecompositions: MAX_REDECOMPOSITIONS,
    priorRedecompositions: countMarked(plannerComments, redecomposedMarker(planner.feature)),
  })
  printNotice(`#${issue.number} (${planner.feature}) → ${describeDecision(decision)}`)

  if (decision.kind === 'idle') return 'idle'
  if (DRY_RUN) {
    printNotice('DRY_RUN=1 — decision reported, nothing executed.')
    return 'idle'
  }
  if (Date.now() - startedAt > PER_RUN_BUDGET_MS) {
    printWarning('Per-run budget exhausted before the action started; stopping. The next run picks it up.')
    return 'stop'
  }

  const out = await executeSafely(
    decision,
    {
      planner,
      plannerIssueNumber: issue.number,
      plannerBody: issue.body ?? '',
      areaLabels: issue.labels.filter(l => l.startsWith('area:')),
      runId: RUN_ID,
    },
    gh,
    claudePlanner(loadTemplates(), RUN_TIMESTAMP),
  )
  if (out.kind === 'quota-stop') {
    // Not an escalation: a quota failure is "come back later" (Q6a carve-out).
    printWarning('Anthropic session limit or transient auth failure; stopping the queue. Nothing was changed.')
    return 'stop'
  }
  if (out.kind === 'acted') {
    printNotice(`#${issue.number}: ${out.summary}`)
    return 'acted'
  }
  return 'idle'
}

/** Open `enhancement` issues WITH bodies (IssueSummary drops them). PRs excluded. */
async function listOpenEnhancements(
  octokit: ReturnType<typeof octokitFromEnv>,
  repo: RepoIdentity,
): Promise<ListedIssue[]> {
  const all = await octokit.paginate(octokit.issues.listForRepo, {
    ...repo,
    state: 'open',
    labels: 'enhancement',
    per_page: 100,
  })
  return all
    .filter(i => !i.pull_request)
    .map(i => ({
      number: i.number,
      title: i.title,
      body: i.body ?? null,
      labels: i.labels.map(l => (typeof l === 'string' ? l : (l.name ?? ''))),
      createdAt: i.created_at,
    }))
}

/** Open PR bodies — a PR that closes a cut puts that cut in flight (Q5a step 2). */
async function listOpenPrs(octokit: ReturnType<typeof octokitFromEnv>, repo: RepoIdentity): Promise<ListedPr[]> {
  const all = await octokit.paginate(octokit.pulls.list, { ...repo, state: 'open', per_page: 100 })
  return all.map(p => ({ number: p.number, body: p.body ?? null }))
}

main().catch((err: unknown) => {
  // Fail loud. A crash here is "cut-planner could not do the job", and Q6a
  // forbids resolving that silently — a non-zero exit surfaces in the
  // workflow run rather than looking like a quiet no-op run.
  console.error(err)
  process.exit(1)
})
