/**
 * prior-reviewer-note — recover the latest reviewer-sourced note for a
 * cut from its historical escalation comments.
 *
 * `priorReviewerNote` is scoped to a single generator-critic run: it
 * starts at null and is only populated when Agent B rejects within the
 * SAME run (route-attempt's `retry-with-note` branch). When the loop
 * exhausts or the reviewer votes NEEDS_HUMAN, the orchestrator
 * escalates to `ready-for-human`; the reviewer's note survives only
 * inside the escalation comment it posts. When the maintainer requeues
 * that cut (removing `ready-for-human` to let feature-bot try again),
 * the next run would otherwise start blind — repeating the mistake
 * that got it rejected. This happened to #517 in 2026-10 and the
 * maintainer had to copy the note into the spec by hand.
 *
 * To avoid this, `escalateToHuman` now tags its outcome marker with
 * `source=reviewer` when the embedded `reasonNote` is Agent B's
 * verdict text, or `source=orchestrator` when it's a message generated
 * by the orchestrator itself (per-cut budget, reviewer crash, Agent A
 * exit, dep rejection, delivery failure). At the start of a new run,
 * this module parses the cut's prior escalation comments for the
 * LATEST `source=reviewer` tag and returns the quoted note so the
 * orchestrator can seed `priorReviewerNote` with it.
 *
 * Legacy (pre-source=) escalation comments are deliberately ignored:
 * without a tag we cannot tell whether their note is Agent B's verdict
 * text or orchestrator metadata, and misclassifying orchestrator text
 * ("Cut exceeded the per-cut time budget…") as reviewer feedback would
 * mislead Agent A. Missing one reviewer note from before this feature
 * shipped is strictly safer than feeding fake reviewer feedback.
 *
 * Pure — the I/O (octokit.listComments) stays in the orchestrator per
 * the same split that keeps route-attempt.ts pure: I/O and parsing are
 * different reasons-to-change (rule 18).
 */

/**
 * Outcome tag marker prefix for an escalation on a given cut issue.
 * The orchestrator appends `source=…` + `-->` to form the full tag.
 */
export function escalationMarker(issueNumber: number): string {
  return `feature-bot: escalation issue=${issueNumber}`
}

export interface EscalationOutcomeTagInput {
  issueNumber: number
  reason: string
  runId: string
  source: 'reviewer' | 'orchestrator'
}

/**
 * Compose the HTML-comment outcome tag that `escalateToHuman` emits.
 * Shared between the production code that emits it and tests that
 * assert on the format, so there's one spelling of the tag.
 */
export function escalationOutcomeTag(opts: EscalationOutcomeTagInput): string {
  return `<!-- ${escalationMarker(opts.issueNumber)} reason=${opts.reason} run=${opts.runId} source=${opts.source} -->`
}

/**
 * Find the latest `source=reviewer` escalation comment for this cut
 * and return its quoted reviewer note, or null if none exists.
 *
 * `commentBodies` is expected to be in chronological order (oldest
 * first — the shape `octokit.issues.listComments` returns).
 */
export function extractPriorReviewerNote(
  commentBodies: readonly (string | null | undefined)[],
  issueNumber: number,
): string | null {
  // `issue=${n}\b` prevents issue=517 from matching issue=5178, and
  // the `[^>]*source=reviewer\b` section pins the required tag within
  // the same HTML comment token.
  const tagPattern = new RegExp(
    `<!--\\s*feature-bot: escalation issue=${issueNumber}\\b[^>]*\\bsource=reviewer\\b[^>]*-->`,
  )
  let latestNote: string | null = null
  for (const body of commentBodies) {
    if (!body) continue
    if (!tagPattern.test(body)) continue
    const note = parseNoteFromBody(body)
    if (note !== null) latestNote = note
  }
  return latestNote
}

/**
 * Parse the `**Note from the loop:**` quoted section out of a
 * feature-bot escalation comment. Returns the note text (lines joined
 * with `\n`), or null if the comment is malformed.
 *
 * The format `escalateToHuman` now emits is:
 *
 *     **Note from the loop:**
 *
 *     > line one
 *     > line two
 *
 *     **Workflow run:** …
 *
 * Each line of the note is prefixed with `> ` (produced by
 * `.replace(/\n/g, '\n> ')`) so the parser can simply consume
 * consecutive blockquote lines after the marker.
 */
function parseNoteFromBody(body: string): string | null {
  const marker = '**Note from the loop:**'
  const idx = body.indexOf(marker)
  if (idx === -1) return null
  const after = body.slice(idx + marker.length)
  const lines = after.split('\n')
  const noteLines: string[] = []
  let started = false
  for (const line of lines) {
    if (!started) {
      if (line.trim() === '') continue
      if (!line.startsWith('> ')) return null
      started = true
      noteLines.push(line.slice(2))
      continue
    }
    // Stop at a blank line OR a non-blockquote line.
    if (line.trim() === '') break
    if (!line.startsWith('> ')) break
    noteLines.push(line.slice(2))
  }
  if (noteLines.length === 0) return null
  const note = noteLines.join('\n').trim()
  return note === '' ? null : note
}
