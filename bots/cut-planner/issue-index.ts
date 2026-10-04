/**
 * Issue index — classify open issues into planner issues and cut issues.
 *
 * Pure: takes already-listed issues and PRs, returns the per-feature view the
 * run dispatcher needs. All I/O stays in the orchestrator.
 *
 * Classification is structural, and the order of the checks is load-bearing:
 *
 *  1. A body with a `## Spec` heading is a CUT. That check runs first because
 *     a cut sitting in `needs-refinement` looks like a planner issue on every
 *     other axis — it is `enhancement`, it has lost `ready-for-agent`, and it
 *     carries `**Feature**:`. Without this check, every handed-back cut would
 *     be read as a malformed planner issue and escalated to a human.
 *  2. A body with `**Feature**:` plus at least one planner signal
 *     (`**Design**:`, `## Suggested plan`, `## State`) is a PLANNER issue —
 *     even if it then fails to parse. A planner issue missing a field is a
 *     feature-scope escalation (Q6a), not something to skip silently.
 *  3. Anything else is ignored. Pre-cut-planner tracking issues carry
 *     `**Feature**:` but none of the planner signals, and must not be
 *     escalated for "missing **Design**".
 */
import type { ObservedCut } from './dispatch-run.js'
import { countMarked, refinedMarker } from './markers.js'

export interface ListedIssue {
  number: number
  title: string
  body: string | null
  labels: readonly string[]
  createdAt: string
}

export interface ListedPr {
  number: number
  body: string | null
}

export type IssueKind = 'cut' | 'planner' | 'other'

const SPEC = /^## Spec\s*$/m
const FEATURE = /^\*\*Feature\*\*:[^\S\n]*(\S+)/m
const PLANNER_SIGNALS = [/^\*\*Design\*\*:/m, /^## Suggested plan\s*$/m, /^## State\s*$/m]

export function classifyIssue(body: string | null): IssueKind {
  const b = body ?? ''
  if (SPEC.test(b)) return 'cut'
  if (FEATURE.test(b) && PLANNER_SIGNALS.some(re => re.test(b))) return 'planner'
  return 'other'
}

/** The `**Feature**:` slug, or null. */
export function featureOf(body: string | null): string | null {
  return FEATURE.exec(body ?? '')?.[1] ?? null
}

/**
 * Issue numbers an open PR claims to close. Matches GitHub's own closing
 * keywords so a PR that would close the cut on merge counts as "in flight".
 */
export function closedByPr(body: string | null): number[] {
  const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi
  return [...(body ?? '').matchAll(re)].map(m => Number(m[1]))
}

/**
 * Build the dispatcher's view of one feature's open cuts.
 *
 * `refinementCounts` maps cut number → bodies of that cut's comments; it is
 * only needed for cuts in `needs-refinement`, so the orchestrator fetches
 * comments for those alone rather than for every cut.
 */
export function observeCuts(
  feature: string,
  issues: readonly ListedIssue[],
  prs: readonly ListedPr[],
  commentsByCut: ReadonlyMap<number, readonly (string | null)[]>,
): ObservedCut[] {
  const inPr = new Set(prs.flatMap(p => closedByPr(p.body)))
  return issues
    .filter(i => classifyIssue(i.body) === 'cut' && featureOf(i.body) === feature)
    .map(i => ({
      issueNumber: i.number,
      needsRefinement: i.labels.includes('needs-refinement'),
      readyForAgent: i.labels.includes('ready-for-agent'),
      hasOpenPr: inPr.has(i.number),
      priorRefinements: countMarked(commentsByCut.get(i.number) ?? [], refinedMarker(i.number)),
      createdAt: i.createdAt,
    }))
}

/**
 * Split the planner issue's `## Locked decisions` section into bullets.
 *
 * Claude selects locks by INDEX, never by text. That makes Q2's "transcribe,
 * never invent" hold by construction: the only lock text that can reach a
 * cut body is text that already exists, verbatim, in the planner issue.
 * Continuation lines (indented) fold into the bullet above them.
 */
export function lockBullets(section: string): string[] {
  const out: string[] = []
  for (const raw of section.split('\n')) {
    if (/^\s*<!--.*-->\s*$/.test(raw) || raw.trim() === '') continue
    const bullet = /^[-*]\s+(.*)$/.exec(raw)
    if (bullet) out.push(bullet[1].trim())
    else if (out.length > 0 && /^\s+\S/.test(raw)) out[out.length - 1] += ` ${raw.trim()}`
  }
  return out
}
