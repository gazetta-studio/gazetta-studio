/**
 * Comment-trigger grammar parser for the review-on-comment workflow.
 *
 * Per design-code-review.md Q-comment-trigger:
 *   @claude review                  -> full Phase 2 orchestrator
 *   @claude review <angle> [...]    -> specific angles
 *   @claude audit <path>            -> Phase 1 audit-area on the path
 *
 * Returns one of three shapes; downstream wrapper dispatches accordingly.
 * Pure function — testable in isolation; no GitHub API calls.
 */

import { ALL_ANGLES, type Angle } from './review-dispatch.js'

export type CommentRequest =
  | { kind: 'review-all' }
  | { kind: 'review-angles'; angles: readonly Angle[] }
  | { kind: 'audit'; path: string }
  | { kind: 'unrecognized'; reason: string }

const ANGLE_SET = new Set<string>(ALL_ANGLES)

/**
 * Parse a comment body for the trigger grammar.
 *
 * The trigger phrase must appear on its own line (defensive against
 * accidental matches in PR descriptions or quoted text). Leading
 * whitespace is permitted; trailing text after the trigger line is
 * ignored except as args on the same line.
 */
export function parseCommentRequest(body: string): CommentRequest {
  // Try each known trigger; the first match wins. Order matters because
  // "review" is a prefix of "review security"; we test the longer form
  // (with args) before deciding.

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()

    // @claude audit <path> [...]
    const auditMatch = line.match(/^@claude\s+audit\s+(\S.*)$/i)
    if (auditMatch) {
      const path = auditMatch[1]!.trim()
      if (path.length === 0) {
        return { kind: 'unrecognized', reason: '@claude audit requires a path argument' }
      }
      return { kind: 'audit', path }
    }

    // @claude review [angle ...]
    const reviewMatch = line.match(/^@claude\s+review(?:\s+(.*))?$/i)
    if (reviewMatch) {
      const argsRaw = reviewMatch[1]?.trim() ?? ''
      if (argsRaw === '') {
        return { kind: 'review-all' }
      }
      // Split args on whitespace; normalize to known angle names.
      const tokens = argsRaw.split(/\s+/)
      const angles: Angle[] = []
      const unknown: string[] = []
      for (const t of tokens) {
        // Accept both "security" (short) and "review-security" (long form)
        const normalized = t.startsWith('review-') ? t : `review-${t}`
        if (ANGLE_SET.has(normalized)) {
          angles.push(normalized as Angle)
        } else {
          unknown.push(t)
        }
      }
      if (unknown.length > 0) {
        return {
          kind: 'unrecognized',
          reason: `unknown angle(s): ${unknown.join(', ')}. Valid: ${ALL_ANGLES.map(a => a.replace(/^review-/, '')).join(', ')}`,
        }
      }
      if (angles.length === 0) {
        // Shouldn't happen — args were non-empty but produced no angles
        // and no unknowns. Defensive fallback.
        return { kind: 'review-all' }
      }
      return { kind: 'review-angles', angles }
    }
  }

  return { kind: 'unrecognized', reason: 'no @claude review or @claude audit trigger found' }
}
