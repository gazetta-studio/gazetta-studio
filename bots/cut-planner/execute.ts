/**
 * Execute one dispatcher decision.
 *
 * Depends on two narrow ports (DIP), not on octokit or the Claude CLI, so
 * every path below is exercised by tests against in-memory fakes:
 *
 *   - `GitHubPort` — the handful of issue writes cut-planner performs
 *   - `PlannerPort` — one Claude call, returning its assistant texts or a
 *     typed infrastructure failure
 *
 * # Write order
 *
 * Writes are not transactional, so their order is chosen to keep an
 * interrupted run recoverable: the real work first (create / revise the
 * cut), then the planner-issue COMMENT (the durable log, Q7), then the
 * planner-issue BODY (`## State`, derived and reconstructible from the log).
 * A run that dies after the cut is created leaves a cut in flight, which the
 * next run correctly reads as "idle" (Q5a step 2).
 *
 * # Failure handling (Q6a)
 *
 * - Quota / transient auth → `quota-stop`: change nothing, retry next cron.
 *   A quota failure is not an inability and must never be escalated.
 * - Anything else cut-planner cannot complete — a failed Claude call, a
 *   malformed answer — escalates to a human at the narrower scope actually
 *   blocked: the cut when a cut is in hand, otherwise the feature.
 */
import { renderCutBody } from './cut-body.js'
import type { RunDecision } from './dispatch-run.js'
import {
  escalateCutComment,
  escalateFeatureComment,
  filedComment,
  questionComment,
  redecomposedComment,
  refinedCutComment,
  refinedLogComment,
  supersededComment,
  workflowCutComment,
} from './comments.js'
import { lockBullets } from './issue-index.js'
import { featureBotHandoffMarker } from './markers.js'
import { type CutSpec, type Mode, parsePlanOutput, type PlanOutput, touchesWorkflows } from './plan-output.js'
import { type PlannerIssue, replaceSection } from './planner-issue.js'

export interface IssueSnapshot {
  title: string
  body: string
  labels: readonly string[]
}

export interface GitHubPort {
  getIssue(n: number): Promise<IssueSnapshot>
  listCommentBodies(n: number): Promise<string[]>
  createIssue(title: string, body: string, labels: readonly string[]): Promise<number>
  updateBody(n: number, body: string): Promise<void>
  comment(n: number, body: string): Promise<void>
  addLabel(n: number, label: string): Promise<void>
  removeLabel(n: number, label: string): Promise<void>
  close(n: number, reason: 'completed' | 'not_planned'): Promise<void>
}

export type PlannerResult =
  | { kind: 'ok'; texts: string[] }
  /** Rate limit or transient auth: "come back later", never an escalation. */
  | { kind: 'quota' }
  /** The call itself failed (non-zero exit, spawn error). */
  | { kind: 'failed'; reason: string }

export interface PlannerPort {
  plan(mode: Mode, context: PlanContext): Promise<PlannerResult>
}

/** Everything a prompt needs; the port turns it into prompt text. */
export interface PlanContext {
  planner: PlannerIssue
  plannerIssueNumber: number
  locks: string[]
  /** Present for refine / redecompose. */
  cut?: { number: number; title: string; body: string; reviewerNote: string | null }
}

export interface FeatureContext {
  planner: PlannerIssue
  plannerIssueNumber: number
  /** Current planner body, needed to rewrite `## State` in place. */
  plannerBody: string
  /** `area: *` labels to copy onto filed cuts. */
  areaLabels: readonly string[]
  runId: string
}

export type ExecOutcome = { kind: 'idle' } | { kind: 'acted'; summary: string } | { kind: 'quota-stop' }

export async function executeDecision(
  decision: RunDecision,
  ctx: FeatureContext,
  gh: GitHubPort,
  planner: PlannerPort,
): Promise<ExecOutcome> {
  const locks = lockBullets(ctx.planner.lockedDecisions)
  switch (decision.kind) {
    case 'idle':
      return { kind: 'idle' }

    case 'escalate-feature':
      await escalateFeature(gh, ctx, 'plan-exhausted', PLAN_EXHAUSTED_DETAIL)
      return { kind: 'acted', summary: 'escalated feature (plan exhausted)' }

    case 'escalate-cut':
      await escalateCut(gh, ctx, decision.issueNumber, decision.reason, budgetDetail(decision.reason))
      return { kind: 'acted', summary: `escalated #${decision.issueNumber} (${decision.reason})` }

    case 'file-next':
      return fileNext(ctx, gh, planner, locks)

    case 'refine':
      return refine(decision.issueNumber, ctx, gh, planner, locks)

    case 'redecompose':
      return redecompose(decision.issueNumber, ctx, gh, planner, locks)
  }
}

const PLAN_EXHAUSTED_DETAIL =
  'The planner issue has no `## Suggested plan` left to work from and no cut is in flight. Either the feature is done (close this issue) or the plan needs extending (add rows to `## Suggested plan`).'

function budgetDetail(reason: string): string {
  return reason === 'redecomposition-failed'
    ? 'Two spec refinements and one re-decomposition did not land it, so rewriting the spec is not the lever. The reviewer comments above say what kept failing.'
    : 'The refinement budget is spent and re-decomposition is not available, so the spec is not the problem — or not one cut-planner can fix.'
}

async function fileNext(
  ctx: FeatureContext,
  gh: GitHubPort,
  planner: PlannerPort,
  locks: string[],
): Promise<ExecOutcome> {
  const out = await ask(
    planner,
    'file',
    { planner: ctx.planner, plannerIssueNumber: ctx.plannerIssueNumber, locks },
    locks,
  )
  if (out.kind === 'quota-stop') return out
  if (out.kind === 'error') {
    await escalateFeature(gh, ctx, 'planning-failed', out.reason)
    return { kind: 'acted', summary: `escalated feature (${out.reason})` }
  }
  const p = out.value
  if (p.action === 'needs-input') return askHuman(gh, ctx, p)
  if (p.action === 'plan-complete') {
    await escalateFeature(gh, ctx, 'plan-exhausted', p.reason)
    return { kind: 'acted', summary: 'escalated feature (plan complete)' }
  }
  if (p.action !== 'file') return unexpected(gh, ctx, p.action)

  const filed = await fileCut(gh, ctx, p, locks)
  await gh.comment(
    ctx.plannerIssueNumber,
    filedComment({
      feature: ctx.planner.feature,
      cutNumber: filed.number,
      title: p.title,
      deviation: p.deviation,
      queued: filed.queued,
      runId: ctx.runId,
    }),
  )
  const state = p.state
    ? withCutNumber(p.state, filed.number)
    : deriveState(ctx.planner.state, [`In flight: #${filed.number} — ${p.title}`])
  await gh.updateBody(ctx.plannerIssueNumber, replaceSection(ctx.plannerBody, 'State', state))
  return { kind: 'acted', summary: `filed #${filed.number}${filed.queued ? '' : ' (not queued: workflow files)'}` }
}

async function refine(
  n: number,
  ctx: FeatureContext,
  gh: GitHubPort,
  planner: PlannerPort,
  locks: string[],
): Promise<ExecOutcome> {
  const cut = await cutContext(gh, n)
  const out = await ask(
    planner,
    'refine',
    { planner: ctx.planner, plannerIssueNumber: ctx.plannerIssueNumber, locks, cut },
    locks,
  )
  if (out.kind === 'quota-stop') return out
  if (out.kind === 'error') {
    await escalateCut(gh, ctx, n, 'refinement-failed', out.reason)
    return { kind: 'acted', summary: `escalated #${n} (${out.reason})` }
  }
  const p = out.value
  if (p.action === 'needs-input') return askHuman(gh, ctx, p)
  if (p.action === 'design-objection') {
    await escalateCut(gh, ctx, n, 'design-objection', p.reason)
    return { kind: 'acted', summary: `escalated #${n} (design objection)` }
  }
  if (p.action !== 'refine') return unexpected(gh, ctx, p.action, n)

  const queued = !touchesWorkflows(p.files)
  await gh.updateBody(n, body(ctx, p, locks))
  await gh.comment(n, refinedCutComment({ cutNumber: n, summary: p.summary, queued, runId: ctx.runId }))
  // Add-before-remove, matching feature-bot's hand-off: a crash between the
  // two leaves the cut carrying BOTH labels (visible, harmless) rather than
  // neither (silently orphaned in no bot's queue).
  await gh.addLabel(n, queued ? 'ready-for-agent' : 'ready-for-human')
  await gh.removeLabel(n, 'needs-refinement')
  await gh.comment(
    ctx.plannerIssueNumber,
    refinedLogComment({ feature: ctx.planner.feature, cutNumber: n, summary: p.summary, runId: ctx.runId }),
  )
  return { kind: 'acted', summary: `refined #${n}` }
}

async function redecompose(
  n: number,
  ctx: FeatureContext,
  gh: GitHubPort,
  planner: PlannerPort,
  locks: string[],
): Promise<ExecOutcome> {
  const cut = await cutContext(gh, n)
  const out = await ask(
    planner,
    'redecompose',
    { planner: ctx.planner, plannerIssueNumber: ctx.plannerIssueNumber, locks, cut },
    locks,
  )
  if (out.kind === 'quota-stop') return out
  if (out.kind === 'error') {
    await escalateCut(gh, ctx, n, 'redecomposition-failed', out.reason)
    return { kind: 'acted', summary: `escalated #${n} (${out.reason})` }
  }
  const p = out.value
  if (p.action === 'needs-input') return askHuman(gh, ctx, p)
  if (p.action === 'design-objection') {
    await escalateCut(gh, ctx, n, 'design-objection', p.reason)
    return { kind: 'acted', summary: `escalated #${n} (design objection)` }
  }
  if (p.action !== 'redecompose') return unexpected(gh, ctx, p.action, n)

  const filed = await fileCut(gh, ctx, p.first, locks)
  await gh.comment(n, supersededComment({ replacement: filed.number, runId: ctx.runId, cutNumber: n }))
  await gh.removeLabel(n, 'needs-refinement')
  await gh.close(n, 'not_planned')
  // This comment's tag is the per-feature re-decomposition counter (Q6).
  await gh.comment(
    ctx.plannerIssueNumber,
    redecomposedComment({
      feature: ctx.planner.feature,
      original: n,
      replacement: filed.number,
      remaining: p.remaining,
      summary: p.summary,
      runId: ctx.runId,
    }),
  )
  const state =
    (p.state ? withCutNumber(p.state, filed.number) : null) ??
    deriveState(ctx.planner.state, [
      `Re-decomposed #${n}; in flight: #${filed.number} — ${p.first.title}`,
      ...p.remaining.map(r => `Next: ${r}`),
    ])
  await gh.updateBody(ctx.plannerIssueNumber, replaceSection(ctx.plannerBody, 'State', state))
  return { kind: 'acted', summary: `re-decomposed #${n} → #${filed.number}` }
}

// ---- helpers --------------------------------------------------------------

type Asked = { kind: 'ok'; value: PlanOutput } | { kind: 'quota-stop' } | { kind: 'error'; reason: string }

async function ask(planner: PlannerPort, mode: Mode, context: PlanContext, locks: string[]): Promise<Asked> {
  const r = await planner.plan(mode, context)
  if (r.kind === 'quota') return { kind: 'quota-stop' }
  if (r.kind === 'failed') return { kind: 'error', reason: `the planning call failed: ${r.reason}` }
  const parsed = parsePlanOutput(r.texts, mode, locks.length)
  if (!parsed.ok) return { kind: 'error', reason: `the planning answer was unusable: ${parsed.reason}` }
  return { kind: 'ok', value: parsed.value }
}

async function cutContext(gh: GitHubPort, n: number): Promise<NonNullable<PlanContext['cut']>> {
  const issue = await gh.getIssue(n)
  const comments = await gh.listCommentBodies(n)
  // The LATEST hand-off carries the verdict this refinement must answer.
  const handoff = [...comments].reverse().find(c => c.includes(featureBotHandoffMarker(n))) ?? null
  return { number: n, title: issue.title, body: issue.body, reviewerNote: handoff }
}

function body(ctx: FeatureContext, c: CutSpec, locks: string[]): string {
  return renderCutBody({
    feature: ctx.planner.feature,
    designPath: ctx.planner.designPath,
    spec: c.spec,
    acceptance: c.acceptance,
    tests: c.tests,
    solid: c.solid ?? undefined,
    lockedDecisions: c.lockIndices.map(i => locks[i]),
    runId: ctx.runId,
  })
}

async function fileCut(
  gh: GitHubPort,
  ctx: FeatureContext,
  c: CutSpec,
  locks: string[],
): Promise<{ number: number; queued: boolean }> {
  // #840: a cut that edits workflow files is RECORDED but never QUEUED —
  // filing it for feature-bot would spend a full loop on undeliverable work.
  const queued = !touchesWorkflows(c.files)
  const labels = ['enhancement', ...ctx.areaLabels, queued ? 'ready-for-agent' : 'ready-for-human']
  const number = await gh.createIssue(`${ctx.planner.feature}: ${c.title}`, body(ctx, c, locks), labels)
  if (!queued) await gh.comment(number, workflowCutComment(ctx.runId, number))
  return { number, queued }
}

async function askHuman(
  gh: GitHubPort,
  ctx: FeatureContext,
  p: Extract<PlanOutput, { action: 'needs-input' }>,
): Promise<ExecOutcome> {
  await gh.comment(
    ctx.plannerIssueNumber,
    questionComment({
      feature: ctx.planner.feature,
      question: p.question,
      options: p.options,
      recommendation: p.recommendation,
      runId: ctx.runId,
    }),
  )
  await gh.addLabel(ctx.plannerIssueNumber, 'needs-info')
  return { kind: 'acted', summary: 'asked a design question (needs-info)' }
}

async function escalateFeature(gh: GitHubPort, ctx: FeatureContext, reason: string, detail: string): Promise<void> {
  await gh.comment(
    ctx.plannerIssueNumber,
    escalateFeatureComment({ feature: ctx.planner.feature, reason, detail, runId: ctx.runId }),
  )
  await gh.addLabel(ctx.plannerIssueNumber, 'needs-info')
}

async function escalateCut(
  gh: GitHubPort,
  ctx: FeatureContext,
  n: number,
  reason: string,
  detail: string,
): Promise<void> {
  await gh.comment(n, escalateCutComment({ cutNumber: n, reason, detail, runId: ctx.runId }))
  await gh.addLabel(n, 'ready-for-human')
  await gh.removeLabel(n, 'needs-refinement')
}

/** Unreachable while parsePlanOutput's per-mode allow-list holds — but Q6a forbids an undefined state. */
async function unexpected(gh: GitHubPort, ctx: FeatureContext, action: string, cut?: number): Promise<ExecOutcome> {
  const detail = `The planning step returned \`${action}\`, which this mode does not handle.`
  if (cut !== undefined) await escalateCut(gh, ctx, cut, 'unexpected-answer', detail)
  else await escalateFeature(gh, ctx, 'unexpected-answer', detail)
  return { kind: 'acted', summary: `escalated (unexpected ${action})` }
}

/**
 * Q6a's catch-all. `executeDecision` handles every failure it can name; this
 * wrapper handles the ones it can't — a GitHub write that throws mid-action,
 * say. The rule is a default, not a list: anything cut-planner cannot
 * complete goes to a human at the narrower scope in hand.
 *
 * If the escalation write itself fails, rethrow. A non-zero exit is the only
 * honest signal left, and it beats a run that looks like a quiet no-op.
 */
export async function executeSafely(
  decision: RunDecision,
  ctx: FeatureContext,
  gh: GitHubPort,
  planner: PlannerPort,
): Promise<ExecOutcome> {
  try {
    return await executeDecision(decision, ctx, gh, planner)
  } catch (err) {
    const detail = `An unexpected error stopped the \`${decision.kind}\` step: ${(err as Error).message ?? String(err)}`
    const cut = 'issueNumber' in decision ? decision.issueNumber : undefined
    if (cut !== undefined) await escalateCut(gh, ctx, cut, 'unexpected-error', detail)
    else await escalateFeature(gh, ctx, 'unexpected-error', detail)
    return { kind: 'acted', summary: `escalated after an unexpected error (${decision.kind})` }
  }
}

/**
 * A planner issue that fails to parse (Q6a, feature scope). cut-planner's
 * own input is broken and guessing would corrupt state, so it names the
 * missing fields and stops. `needs-info` takes the issue out of discovery
 * until a human fixes it, so this fires once rather than every run.
 */
export async function escalateMalformedPlanner(
  gh: GitHubPort,
  issueNumber: number,
  feature: string | null,
  missing: readonly string[],
  runId: string,
): Promise<void> {
  const detail = `This looks like a planner issue but is missing ${missing.map(m => `\`${m}\``).join(' and ')}. Add the missing front-matter (see \`.claude/rules/design-cut-planner.md\` Q1 for the shape).`
  await gh.comment(
    issueNumber,
    escalateFeatureComment({ feature: feature ?? `#${issueNumber}`, reason: 'malformed-planner-issue', detail, runId }),
  )
  await gh.addLabel(issueNumber, 'needs-info')
}

/**
 * A correct minimal `## State` when the planning answer omits one.
 *
 * `## State` is derived data (Q7): the comment log is the durable record
 * and state is reconstructible from it. So the executor can always produce
 * it — the previous state, with any old "In flight" / "Next" lines dropped
 * (they are now stale) and the new lines appended. Claude's own state, when
 * present, is preferred because it can also say what comes after.
 */
export function deriveState(previous: string, newLines: readonly string[]): string {
  const kept = previous.split('\n').filter(l => !/^\s*(in flight|next|nothing has landed)/i.test(l) && l.trim() !== '')
  return [...kept, ...newLines].join('\n')
}

/**
 * Replace the `#NEW` placeholder in Claude's state with the filed number.
 *
 * Claude writes `## State` before the cut exists, so it cannot know the
 * number; the prompts ask for `#NEW` instead. Word-bounded so `#NEWS` or
 * `#NEWER` in prose are left alone.
 */
export function withCutNumber(state: string, cutNumber: number): string {
  return state.replace(/#NEW\b/g, `#${cutNumber}`)
}
