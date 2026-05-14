/**
 * Reviewer verdict parser.
 *
 * Agent B (the reviewer in dead-code-watcher's generator-critic loop)
 * emits its outcome as a structured line in its final text block:
 *
 *   VERDICT: APPROVE
 *   Reasoning: ...
 *
 *   VERDICT: REJECT
 *   Note: <feedback for Agent A>
 *
 *   VERDICT: NEEDS_HUMAN
 *   Note: <reason this can't be auto-resolved>
 *
 * The orchestrator parses the reviewer's last assistant text block for
 * the VERDICT line. If parsing fails (Claude misformatted the output),
 * we default to NEEDS_HUMAN with a parser-failure note so the finding
 * doesn't silently retry on garbage.
 */

export type ReviewerVerdict =
  | { kind: 'approve'; reasoning: string }
  | { kind: 'reject'; note: string }
  | { kind: 'needs-human'; note: string }

const VERDICT_LINE = /^\s*VERDICT:\s*(APPROVE|REJECT|NEEDS_HUMAN)\s*$/m

/** Pull the body following an optional `Note:` / `Reasoning:` keyword. */
function extractNote(text: string, after: number): string {
  // Take everything after the VERDICT line, strip leading "Note: " or
  // "Reasoning: " if present, trim, truncate.
  const tail = text.slice(after).trimStart()
  const stripped = tail.replace(/^(Note|Reasoning):\s*/i, '')
  return stripped.trim().slice(0, 2000)
}

/**
 * Parse a reviewer's final text block into a verdict.
 *
 * Defaults to NEEDS_HUMAN when:
 *   - No VERDICT line is found
 *   - VERDICT keyword is recognized but malformed
 *
 * This is the safe default: ambiguous output should NOT silently
 * default to APPROVE (which would push code) or REJECT (which would
 * loop). NEEDS_HUMAN puts the finding on the skip-list and stops.
 */
export function parseReviewerVerdict(text: string): ReviewerVerdict {
  const match = text.match(VERDICT_LINE)
  if (!match) {
    return {
      kind: 'needs-human',
      note: `Reviewer output did not contain a recognizable "VERDICT: APPROVE|REJECT|NEEDS_HUMAN" line. Raw output: ${text.slice(0, 500)}`,
    }
  }
  const verdict = match[1]
  const lineEnd = (match.index ?? 0) + match[0].length
  const tail = extractNote(text, lineEnd)
  if (verdict === 'APPROVE') {
    return { kind: 'approve', reasoning: tail || '(no reasoning provided)' }
  }
  if (verdict === 'REJECT') {
    if (!tail) {
      return {
        kind: 'needs-human',
        note: 'Reviewer voted REJECT but provided no Note: explanation. Cannot retry without feedback.',
      }
    }
    return { kind: 'reject', note: tail }
  }
  // NEEDS_HUMAN
  return { kind: 'needs-human', note: tail || '(no reason provided)' }
}
