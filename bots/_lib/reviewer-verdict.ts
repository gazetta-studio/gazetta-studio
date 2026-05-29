/**
 * Reviewer verdict parser.
 *
 * Agent B (the reviewer in dead-code-watcher's + fix-bot's
 * generator-critic loops) is supposed to emit its outcome as a
 * structured line in its FINAL text block:
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
 * In practice Agent B is talkative and sometimes emits the VERDICT
 * line in an EARLIER message, then closes with a meta-comment like
 * "Forming verdict." The orchestrator originally extracted only the
 * last assistant text and called `parseReviewerVerdict` on that —
 * which produced false NEEDS_HUMAN defaults on real substantive
 * reviews. See run 26325999185 (2026-05-23) where #414/#415 hit
 * this. PR fix/fix-bot-loop-exhausted-visibility addresses by adding
 * the multi-block search via `parseReviewerTranscript`.
 *
 * If parsing fails entirely (no VERDICT line, no recognisable soft
 * signal), we default to NEEDS_HUMAN with a parser-failure note so
 * the finding doesn't silently retry on garbage.
 */

export type ReviewerVerdict =
  | { kind: 'approve'; reasoning: string }
  | { kind: 'reject'; note: string }
  | { kind: 'needs-human'; note: string }

const VERDICT_LINE = /^\s*VERDICT:\s*(APPROVE|REJECT|NEEDS_HUMAN)\s*$/m
/**
 * Softer-signal fallback. Agent B sometimes writes
 * `> Decision: approve.` or `Recommendation: REJECT` instead of the
 * exact VERDICT line. Match these as last-chance signals before
 * defaulting to NEEDS_HUMAN.
 *
 * Case-insensitive; matches at line start; allows optional leading
 * blockquote/marker chars.
 */
const SOFT_DECISION_LINE = /^[>*\s]*(?:Decision|Recommendation|Verdict)\s*:?\s+(approve|reject|needs[_-]?human)\b/im

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
  // First try the strict VERDICT line. Use matchAll + last-occurrence so a
  // "thinking out loud — VERDICT: REJECT? actually..." preamble doesn't
  // outvote the final commitment.
  const allMatches = [...text.matchAll(new RegExp(VERDICT_LINE, 'gm'))]
  const lastMatch = allMatches.at(-1)
  if (lastMatch) {
    const verdict = lastMatch[1]
    const lineEnd = (lastMatch.index ?? 0) + lastMatch[0].length
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

  // Fallback: look for a softer signal (`> Decision: approve` etc.) before
  // defaulting to needs-human. Same last-occurrence semantic.
  const softMatches = [...text.matchAll(new RegExp(SOFT_DECISION_LINE, 'gim'))]
  const lastSoft = softMatches.at(-1)
  if (lastSoft) {
    const word = lastSoft[1].toLowerCase().replace('_', '-').replace('needshuman', 'needs-human')
    const lineEnd = (lastSoft.index ?? 0) + lastSoft[0].length
    const tail = extractNote(text, lineEnd)
    if (word === 'approve') {
      return { kind: 'approve', reasoning: tail || '(soft signal: no reasoning provided)' }
    }
    if (word === 'reject') {
      if (!tail) {
        return {
          kind: 'needs-human',
          note: 'Reviewer soft-signal "Decision: reject" had no explanation. Cannot retry without feedback.',
        }
      }
      return { kind: 'reject', note: tail }
    }
    return { kind: 'needs-human', note: tail || '(soft signal: no reason provided)' }
  }

  return {
    kind: 'needs-human',
    note: `Reviewer output did not contain a recognizable "VERDICT: APPROVE|REJECT|NEEDS_HUMAN" line. Raw output: ${text.slice(0, 500)}`,
  }
}

/**
 * Parse a reviewer's FULL transcript (all assistant text blocks joined)
 * rather than just the last block. Use this when Agent B may have
 * emitted the VERDICT line in an earlier message and then continued
 * with closing commentary.
 *
 * Implementation: concatenate all blocks with newlines, then run the
 * same parser. The last-occurrence semantic in parseReviewerVerdict
 * means later VERDICT lines override earlier ones, so a reviewer that
 * said "Initially I thought REJECT, but actually VERDICT: APPROVE" gets
 * parsed as APPROVE.
 */
export function parseReviewerTranscript(assistantTexts: string[]): ReviewerVerdict {
  return parseReviewerVerdict(assistantTexts.join('\n\n'))
}
