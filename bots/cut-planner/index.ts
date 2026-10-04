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
 * # Cut 3 status (this file)
 *
 * Cut 3 ships the skeleton: discovery of planner issues, the parser, and
 * the banner/summary scaffolding. It takes NO action yet — the run
 * dispatcher is Cut 4, file-next-cut is Cut 5, refine is Cut 6. Running it
 * today reports what it found and exits, which is also what `DRY_RUN=1`
 * will do permanently.
 *
 * # Input contract
 *
 * The planner issue, and nothing else (design-cut-planner.md open-Q 4).
 * cut-planner never reads a design doc or an impl doc; seeding is
 * maintainer work. Discovery is a label query:
 *
 *   `enhancement` + `area: *`, WITHOUT `ready-for-agent`
 *
 * — the same trick that makes tracking issues invisible to feature-bot,
 * applied in reverse. A planner issue deliberately lacks
 * `ready-for-agent`, so feature-bot ignores it and cut-planner claims it.
 * The `**Feature**:` front-matter is what distinguishes a planner issue
 * from any other non-cut enhancement issue.
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
import { findIssuesByLabels, octokitFromEnv, repoFromEnv, type RepoIdentity } from '../_lib/github.js'
import { printBanner, printCandidateList, printNotice, printRunSummary, printWarning } from '../_lib/ui.js'
import { dispatchRun, type RunDecision } from './dispatch-run.js'
import { parsePlannerIssue, type PlannerIssue } from './planner-issue.js'

const DRY_RUN = process.env.DRY_RUN === '1'

/**
 * Per-RUN wall-clock budget. Far smaller than feature-bot's 150 min
 * because cut-planner does at most ONE action per run (Q5a) and that
 * action is a single Claude call to render or revise one cut body — not a
 * generator-critic loop.
 */
const PER_RUN_BUDGET_MS = Number(process.env.BUDGET_MS ?? 30 * 60 * 1000)

/**
 * Spec-refinement budget per cut (design-cut-planner.md Q6).
 *
 * Defaults to 0 to match feature-bot's MAX_REFINEMENTS: until Cut 6 ships
 * the refine path, an armed hand-off would park cuts in a queue nothing
 * reads. See the design doc's "Arming order" — raising this is part of
 * Cut 6's definition of done, not a follow-up.
 */
const MAX_REFINEMENTS = Number(process.env.MAX_REFINEMENTS ?? '0')
/** Re-decomposition budget per feature; the Q6 fallback after refinement. */
const MAX_REDECOMPOSITIONS = Number(process.env.MAX_REDECOMPOSITIONS ?? '1')

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

interface PlannerCandidate {
  issueNumber: number
  title: string
  parsed: PlannerIssue
}

async function main(): Promise<void> {
  const repo = repoFromEnv()
  const octokit = octokitFromEnv()
  const startedAt = Date.now()

  printBanner({
    name: 'cut-planner',
    tagline: 'cut pipeline owner (Cut 3 — skeleton + parser)',
    purpose:
      'File the next cut sub-issue for feature-bot one at a time, and revise a cut spec when the generator-critic loop cannot land it.',
    inputs: [
      'Planner issues: `enhancement` + `area: *`, WITHOUT `ready-for-agent`, carrying `**Feature**:`',
      'Refinement queue: cut sub-issues labelled `needs-refinement` (Cut 6)',
    ],
    outputs: [
      'One cut sub-issue per run (Cut 5)',
      'Revised cut specs + label swap back to `ready-for-agent` (Cut 6)',
      '`needs-info` on the planner issue when a design decision is missing (Cut 8)',
    ],
  })

  const candidates = await discoverPlannerIssues(octokit, repo)

  if (candidates.length === 0) {
    // Absence-as-state per rule 23: nothing to say, so say nothing beyond
    // the run summary. No "nothing to file" comment is ever posted.
    printNotice('No planner issues found. Nothing to do.')
    printRunSummary({
      verb: 'Planned',
      processed: 0,
      total: 0,
      skipped: 0,
      elapsedSec: Math.round((Date.now() - startedAt) / 1000),
    })
    return
  }

  printCandidateList({
    noun: 'planner issue',
    candidates: candidates.map(c => ({
      ref: `#${c.issueNumber}`,
      label: c.parsed.feature,
      meta: c.title,
    })),
  })

  // Decide the ONE action per feature (Q5a). Cut 4 ships the decision;
  // EXECUTING it is Cuts 5-8, so every decision is reported and not acted
  // on. That is deliberate and visible — the banner says so — rather than
  // a silent skip in the Q6a sense.
  for (const c of candidates) {
    const decision = dispatchRun({
      planner: c.parsed,
      plannerIssueNumber: c.issueNumber,
      // Cut 5 populates this from a real cut-sub-issue query. An empty set
      // makes the dispatcher report `file-next` (or `escalate-feature` on
      // an empty plan), which is the correct decision for a feature with
      // no cuts yet.
      cuts: [],
      maxRefinements: MAX_REFINEMENTS,
      maxRedecompositions: MAX_REDECOMPOSITIONS,
      priorRedecompositions: 0,
    })
    printNotice(`#${c.issueNumber} (${c.parsed.feature}) → ${describeDecision(decision)}`)
  }

  if (DRY_RUN) printNotice('DRY_RUN=1 — decisions reported, nothing executed.')
  else printNotice('Cut 4 ships the decision only; execution is Cuts 5-8. Taking no action.')

  printRunSummary({
    verb: 'Planned',
    processed: 0,
    total: candidates.length,
    skipped: candidates.length,
    elapsedSec: Math.round((Date.now() - startedAt) / 1000),
  })
  void PER_RUN_BUDGET_MS
}

/**
 * Find planner issues.
 *
 * A planner issue is `enhancement` WITHOUT `ready-for-agent` (so
 * feature-bot ignores it) whose body carries `**Feature**:`. The
 * front-matter check is what separates a planner issue from the ~41 other
 * non-cut enhancement issues in the repo — a label alone would not.
 *
 * A body that has `**Feature**:` but fails to parse is NOT skipped
 * silently: it is reported here and escalated by Cut 8, because a broken
 * input is a feature-scope escalation per Q6a rather than something to
 * guess past.
 */
async function discoverPlannerIssues(
  octokit: ReturnType<typeof octokitFromEnv>,
  repo: RepoIdentity,
): Promise<PlannerCandidate[]> {
  const issues = await findIssuesByLabels(octokit, repo, {
    requireAll: ['enhancement'],
    excludeAny: ['ready-for-agent', 'ready-for-human', 'wontfix', 'needs-info'],
  })

  const out: PlannerCandidate[] = []
  for (const issue of issues) {
    // `IssueSummary` carries no body, so fetch it per candidate. The label
    // query already narrows to open non-cut enhancement issues (tens, not
    // thousands), so this is a bounded fan-out rather than a scan.
    const { data: full } = await octokit.issues.get({ ...repo, issue_number: issue.number })
    const body = full.body ?? ''
    // Cheap pre-filter: skip the many non-cut enhancement issues without
    // paying a parse. Not a correctness gate — the parse below is.
    if (!/^\*\*Feature\*\*:/m.test(body)) continue

    const parsed = parsePlannerIssue(body)
    if (!parsed.ok) {
      printWarning(
        `#${issue.number} looks like a planner issue but is missing ${parsed.missing.join(' and ')}; it needs a human (Cut 8 will escalate).`,
      )
      continue
    }
    out.push({ issueNumber: issue.number, title: issue.title, parsed: parsed.value })
  }
  return out
}

main().catch((err: unknown) => {
  // Fail loud. A crash here is "cut-planner could not do the job", and Q6a
  // forbids resolving that silently — a non-zero exit surfaces in the
  // workflow run rather than looking like a quiet no-op run.
  console.error(err)
  process.exit(1)
})
