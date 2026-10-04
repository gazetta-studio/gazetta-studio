/**
 * Validate-cut-sub-issue — orchestrator's pre-Claude gate.
 *
 * Per design-feature-bot.md Q3, the orchestrator MUST loud-fail on bad
 * cut sub-issue bodies + bad dep refs without invoking Claude. This
 * module combines Cut 2's parser (`bots/_lib/cut-parser.ts`) with
 * cron-tick GitHub queries against the live issue tree.
 *
 * Returns a tagged-union result the orchestrator routes on:
 *
 *   - ready — parser + all dep refs valid + all deps LANDED (see _lib/cut-landing.ts)
 *   - body-error — Spec/Acceptance/Tests missing or **Feature** missing
 *   - self-reference — body refs its own issue number (spec-too-vague)
 *   - dep-invalid — a referenced issue doesn't exist OR lacks `enhancement`
 *   - dep-open — at least one dep is still open (wait for it)
 *   - dep-rejected — at least one dep was closed as not planned
 *   - dep-unverified — a dep is closed as completed, but no merged PR names it
 *     (#517: closed by an unrelated PR; its storage never existed)
 *
 * Pure orchestration over `parseCutBody` + `validateParsedCut` + per-dep
 * octokit lookups. Octokit type is imported narrowly to avoid pulling
 * the entire Octokit surface into a tested module — we only need
 * `.issues.get`.
 */
import { parseCutBody, validateParsedCut, type ParsedCut, type ValidationError } from '../_lib/cut-parser.js'
import { classifyLanding, fetchCloseEvent, type GraphqlClient } from '../_lib/cut-landing.js'
import type { RepoIdentity } from '../_lib/github.js'

/**
 * Narrow octokit surface — what this validator needs. Defined locally
 * so tests can mock just the `issues.get` shape without depending on
 * Octokit's full type. ISP per rule 18.
 */
export interface IssuesGetClient {
  issues: {
    get: (opts: { owner: string; repo: string; issue_number: number }) => Promise<{
      data: {
        number: number
        state: 'open' | 'closed'
        state_reason?: 'completed' | 'not_planned' | 'reopened' | null
        labels: Array<string | { name?: string }>
        pull_request?: { merged_at?: string | null }
      }
    }>
  }
  /** For the closing event of a closed dep — `octokit.graphql`. */
  graphql: GraphqlClient
}

export type CutValidationResult =
  | { kind: 'ready'; parsed: ParsedCut }
  | { kind: 'body-error'; parsed: ParsedCut; errors: readonly ValidationError[] }
  | { kind: 'self-reference'; parsed: ParsedCut }
  | { kind: 'dep-invalid'; parsed: ParsedCut; depNumber: number; reason: 'not-found' | 'not-a-cut' }
  | { kind: 'dep-open'; parsed: ParsedCut; openDeps: readonly number[] }
  | { kind: 'dep-rejected'; parsed: ParsedCut; depNumber: number }
  | { kind: 'dep-unverified'; parsed: ParsedCut; depNumber: number }

/**
 * Validate a cut sub-issue body + dep references against the live tree.
 *
 * Step 1: parse the body.
 * Step 2: structural validation via cut-parser's `validateParsedCut`.
 *         - self-reference → return immediately with spec-too-vague.
 *         - other body errors → return body-error.
 * Step 3: per-dep lookup via octokit.
 *         - 404 → dep-invalid (not-found)
 *         - not labeled `enhancement` → dep-invalid (not-a-cut)
 *         - state: 'open' → dep-open (wait, no labels applied by caller)
 *         - closed as not planned → dep-rejected
 *         - closed as completed, no merged PR names it → dep-unverified
 * Step 4: all deps OK → return ready.
 *
 * The orchestrator routes each result to a distinct action:
 *   - body-error → comment + `needs-info` label
 *   - self-reference → `ready-for-human` + skip-list (spec-too-vague)
 *   - dep-invalid → comment + `needs-info`
 *   - dep-open → comment "wait for #N" + NO labels (retry next cron)
 *   - dep-rejected → `ready-for-human` + skip-list
 *   - dep-unverified → comment + `needs-info` (a human says whether it landed)
 *   - ready → proceed to generator-critic loop
 *
 * Error priority when multiple deps fail: dep-invalid > dep-rejected >
 * dep-unverified > dep-open. Most-terminal first matches the orchestrator's action
 * granularity (invalid/rejected require maintainer; open just needs
 * patience).
 */
export async function validateCutSubIssue(
  octokit: IssuesGetClient,
  repo: RepoIdentity,
  ownIssueNumber: number,
  body: string,
): Promise<CutValidationResult> {
  const parsed = parseCutBody(body)
  const errors = validateParsedCut(parsed, ownIssueNumber)

  // Self-reference is a more terminal failure than missing-required-section —
  // it implies the author intended the cut to depend on itself, which is
  // structurally broken. Surface it as spec-too-vague.
  const selfRef = errors.find(e => e.kind === 'invalid-dep-ref' && e.reason === 'self-reference')
  if (selfRef) {
    return { kind: 'self-reference', parsed }
  }

  // Other body errors (missing-feature, missing-required-section) → body-error.
  // These need a maintainer to edit the sub-issue body.
  const bodyErrors = errors.filter(e => e.kind !== 'invalid-dep-ref')
  if (bodyErrors.length > 0) {
    return { kind: 'body-error', parsed, errors: bodyErrors }
  }

  // No body errors. Validate deps against live tree.
  const openDeps: number[] = []
  let firstInvalid: { depNumber: number; reason: 'not-found' | 'not-a-cut' } | null = null
  let firstRejected: number | null = null
  let firstUnverified: number | null = null

  for (const depNumber of parsed.dependsOn) {
    const lookup = await lookupDep(octokit, repo, depNumber)
    if (lookup.kind === 'not-found' || lookup.kind === 'not-a-cut') {
      if (firstInvalid === null) {
        firstInvalid = { depNumber, reason: lookup.kind }
      }
      continue
    }
    if (lookup.kind === 'open') {
      openDeps.push(depNumber)
      continue
    }
    if (lookup.kind === 'closed-not-merged') {
      if (firstRejected === null) {
        firstRejected = depNumber
      }
      continue
    }
    if (lookup.kind === 'closed-unverified') {
      if (firstUnverified === null) {
        firstUnverified = depNumber
      }
      continue
    }
    // landed — proceed.
  }

  // Priority: invalid > rejected > open.
  if (firstInvalid !== null) {
    return { kind: 'dep-invalid', parsed, depNumber: firstInvalid.depNumber, reason: firstInvalid.reason }
  }
  if (firstRejected !== null) {
    return { kind: 'dep-rejected', parsed, depNumber: firstRejected }
  }
  if (firstUnverified !== null) {
    return { kind: 'dep-unverified', parsed, depNumber: firstUnverified }
  }
  if (openDeps.length > 0) {
    return { kind: 'dep-open', parsed, openDeps }
  }
  return { kind: 'ready', parsed }
}

type DepLookup =
  | { kind: 'not-found' }
  | { kind: 'not-a-cut' }
  | { kind: 'open' }
  | { kind: 'landed' }
  | { kind: 'closed-not-merged' }
  | { kind: 'closed-unverified' }

async function lookupDep(octokit: IssuesGetClient, repo: RepoIdentity, depNumber: number): Promise<DepLookup> {
  try {
    const { data } = await octokit.issues.get({
      owner: repo.owner,
      repo: repo.repo,
      issue_number: depNumber,
    })
    const labels = data.labels.map(l => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean)
    if (!labels.includes('enhancement')) {
      return { kind: 'not-a-cut' }
    }
    if (data.state === 'open') {
      return { kind: 'open' }
    }
    // Closed. `state_reason: 'completed'` does NOT mean a PR landed it (#517
    // was closed as completed by an unrelated PR), so ask who closed it.
    const landing = classifyLanding(depNumber, await fetchCloseEvent(octokit.graphql, repo, depNumber))
    if (landing === 'landed') return { kind: 'landed' }
    if (landing === 'superseded') return { kind: 'closed-not-merged' }
    return { kind: 'closed-unverified' }
  } catch (err) {
    if ((err as { status?: number }).status === 404) {
      return { kind: 'not-found' }
    }
    throw err
  }
}
