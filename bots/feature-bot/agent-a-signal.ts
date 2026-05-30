/**
 * Agent A signal parser — Cut 3 of feature-bot.
 *
 * Per design-feature-bot.md Q6, Agent A has THREE terminal states:
 *
 *   1. APPROVE_IMPLICIT — commits exist on the branch, no signal block
 *      in final text. Orchestrator invokes Agent B next.
 *   2. NEEDS_INPUT block in final text:
 *        NEEDS_INPUT: <one-line question>
 *        Options:
 *          - <option 1 with reasoning>
 *          - <option 2 with reasoning>
 *        Recommendation: <option N because ...>
 *      Orchestrator posts the question as a comment with outcome tag,
 *      applies `needs-info`, resets working tree.
 *   3. NEEDS_HUMAN block in final text:
 *        NEEDS_HUMAN: <one-line reason>
 *        Reason-code: <one of: missing-prereq | spec-too-vague | files-conflict | needs-human>
 *      Orchestrator escalates to skip-list + ready-for-human.
 *
 * Why this is a separate module from bots/_lib/reviewer-verdict.ts:
 *   - Different grammars (NEEDS_INPUT block vs VERDICT line)
 *   - Different consumers (this parses Agent A; reviewer-verdict parses Agent B)
 *   - SRP per rule 18: each parser owns one signal shape
 *
 * Last-occurrence semantic mirrors reviewer-verdict's: if Agent A
 * thought out loud ("NEEDS_INPUT: ... actually no, NEEDS_HUMAN: ...")
 * the LATER block wins. Matches Claude's natural revision pattern.
 */

/** Closed enum of reason codes Agent A may emit on the NEEDS_HUMAN path. */
export type AgentAReasonCode = 'missing-prereq' | 'spec-too-vague' | 'files-conflict' | 'needs-human'

const VALID_REASON_CODES: readonly AgentAReasonCode[] = [
  'missing-prereq',
  'spec-too-vague',
  'files-conflict',
  'needs-human',
]

export type AgentASignal =
  | { kind: 'approve-implicit' }
  | { kind: 'needs-input'; question: string; body: string }
  | { kind: 'needs-human'; reason: string; reasonCode: AgentAReasonCode }

/**
 * Parse Agent A's final assistant text into a terminal-state signal.
 *
 * Approve-implicit is the default — no signal block means Agent A
 * committed work and expects Agent B's review.
 *
 * NEEDS_INPUT and NEEDS_HUMAN blocks are detected by matching the
 * "<KEYWORD>: " prefix at line start. The orchestrator passes the
 * MATCHED block's body verbatim onto the GitHub comment (NEEDS_INPUT)
 * or into the skip-list entry's reason-note (NEEDS_HUMAN).
 *
 * When both block types appear (Agent A revised mid-stream), the LAST
 * one wins — same last-occurrence semantic as reviewer-verdict.
 */
export function parseAgentASignal(text: string): AgentASignal {
  // Find the last occurrence of each signal keyword. Whichever has the
  // higher index wins.
  const lastInput = findLastBlockStart(text, 'NEEDS_INPUT:')
  const lastHuman = findLastBlockStart(text, 'NEEDS_HUMAN:')

  if (lastInput === -1 && lastHuman === -1) {
    return { kind: 'approve-implicit' }
  }

  if (lastHuman > lastInput) {
    return parseNeedsHuman(text, lastHuman)
  }
  return parseNeedsInput(text, lastInput)
}

/**
 * Find the start index of the LAST line that begins with `marker`.
 * Returns -1 when not found. Lines may have leading whitespace, but the
 * marker itself must be at column N where everything to the left is
 * pure whitespace — same shape as reviewer-verdict's regex.
 */
function findLastBlockStart(text: string, marker: string): number {
  const pattern = new RegExp(`^[\\s]*${escapeRegex(marker)}`, 'gm')
  const matches = [...text.matchAll(pattern)]
  if (matches.length === 0) return -1
  const last = matches.at(-1)!
  return last.index ?? -1
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseNeedsInput(text: string, startIdx: number): AgentASignal {
  // Extract the question from the NEEDS_INPUT: line (up to next newline).
  const tail = text.slice(startIdx)
  const headerMatch = tail.match(/^[\s]*NEEDS_INPUT:\s*(.*)/)
  const question = headerMatch?.[1]?.trim() ?? ''
  // Body is everything from the NEEDS_INPUT line onward (orchestrator
  // posts the whole block as a comment so authors see options +
  // recommendation).
  const body = tail.trim()
  return { kind: 'needs-input', question, body }
}

function parseNeedsHuman(text: string, startIdx: number): AgentASignal {
  const tail = text.slice(startIdx)
  // Match NEEDS_HUMAN: <reason>\n[optional Reason-code: <code>]
  const headerMatch = tail.match(/^[\s]*NEEDS_HUMAN:\s*(.*)/)
  const reason = headerMatch?.[1]?.trim() ?? ''
  const codeMatch = tail.match(/^[\s]*Reason-code:\s*([a-zA-Z-]+)\s*$/m)
  const rawCode = codeMatch?.[1]?.trim() ?? ''
  const reasonCode: AgentAReasonCode = isValidReasonCode(rawCode) ? rawCode : 'needs-human'
  return { kind: 'needs-human', reason, reasonCode }
}

function isValidReasonCode(code: string): code is AgentAReasonCode {
  return (VALID_REASON_CODES as readonly string[]).includes(code)
}
