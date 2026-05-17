/**
 * Verdict-folding helper — turn aggregated review-orchestrator findings
 * into a review-bot verdict per the action-policy table from
 * design-code-review.md "Consumer action policies".
 *
 * Severity → verdict (review-bot row):
 *   any CRITICAL    → REJECT (or NEEDS_HUMAN if redesign required)
 *   only IMPORTANT  → REJECT with note
 *   only NIT/empty  → APPROVE
 *
 * The "redesign required" hint is heuristic — we mark NEEDS_HUMAN when
 * a CRITICAL finding cites a foundational design doc (architecture +
 * security are the high-stakes angles). Retry-on-REJECT is bounded by
 * MAX_ATTEMPTS at the orchestrator level.
 */

export type SkillSeverity = 'CRITICAL' | 'IMPORTANT' | 'NIT'

export interface SkillFinding {
  severity: SkillSeverity
  file: string
  line: number
  confidence: number
  category: string
  rule: string
  message: string
  suggestion: string
}

export type ReviewBotVerdict =
  | { kind: 'approve'; reasoning: string }
  | { kind: 'reject'; note: string; findings: readonly SkillFinding[] }
  | { kind: 'needs-human'; note: string; findings: readonly SkillFinding[] }

/**
 * Parse a `findings` fence body (JSONL, one finding per line) into
 * typed SkillFinding[]. Tolerates malformed lines (skips them with no
 * fail; the bot continues rather than crash on a partial fence).
 */
export function parseFindingsFence(fenceBody: string): SkillFinding[] {
  const out: SkillFinding[] = []
  for (const line of fenceBody.split('\n')) {
    if (!line.trim()) continue
    try {
      const f = JSON.parse(line) as Partial<SkillFinding>
      if (
        typeof f.severity === 'string' &&
        (f.severity === 'CRITICAL' || f.severity === 'IMPORTANT' || f.severity === 'NIT') &&
        typeof f.file === 'string' &&
        typeof f.line === 'number' &&
        typeof f.confidence === 'number'
      ) {
        out.push({
          severity: f.severity,
          file: f.file,
          line: f.line,
          confidence: f.confidence,
          category: f.category ?? 'correctness',
          rule: f.rule ?? '',
          message: f.message ?? '',
          suggestion: f.suggestion ?? '',
        })
      }
    } catch {
      // malformed — skip
    }
  }
  return out
}

/**
 * Extract the `findings` JSONL fence body from the review-orchestrator's
 * final assistant text. Returns the empty string when no fence is found
 * (treated as "no findings" downstream).
 */
export function extractFindingsFence(text: string): string {
  const m = text.match(/```findings\n([\s\S]*?)\n```/)
  return m?.[1] ?? ''
}

/**
 * Apply the review-bot action policy.
 *
 * @param findings parsed findings (≥80 confidence; aggregator already
 *                 filtered, this function trusts the input)
 * @param hasReviewBlockingDesignDoc heuristic: when a CRITICAL finding
 *                 cites a foundational design doc (audit/validation/
 *                 hooks/auth-rbac/etc.), prefer NEEDS_HUMAN over REJECT
 *                 because the issue likely needs maintainer judgment
 *                 not retry. Caller passes true when ANY CRITICAL's
 *                 `rule` field starts with "design-".
 */
export function applyActionPolicy(findings: readonly SkillFinding[]): ReviewBotVerdict {
  const criticals = findings.filter(f => f.severity === 'CRITICAL')
  const importants = findings.filter(f => f.severity === 'IMPORTANT')
  const nits = findings.filter(f => f.severity === 'NIT')

  if (criticals.length === 0 && importants.length === 0) {
    return {
      kind: 'approve',
      reasoning:
        nits.length === 0
          ? 'all checks passed; no findings emitted by any angle'
          : `${nits.length} NIT finding(s); no blocking issues — APPROVE`,
    }
  }

  if (criticals.length > 0) {
    const designDocCited = criticals.some(f => /design-[a-z-]+\.md/.test(f.rule))
    const note = formatNote(criticals, importants)
    return designDocCited
      ? { kind: 'needs-human', note, findings: criticals }
      : { kind: 'reject', note, findings: criticals }
  }

  // importants > 0, criticals == 0
  return {
    kind: 'reject',
    note: formatNote([], importants),
    findings: importants,
  }
}

function formatNote(criticals: readonly SkillFinding[], importants: readonly SkillFinding[]): string {
  const lines: string[] = []
  for (const f of criticals) {
    lines.push(`- [CRITICAL] ${f.file}:${f.line} — ${f.message} (per ${f.rule}). Suggestion: ${f.suggestion}`)
  }
  for (const f of importants) {
    lines.push(`- [IMPORTANT] ${f.file}:${f.line} — ${f.message} (per ${f.rule}). Suggestion: ${f.suggestion}`)
  }
  return lines.join('\n')
}
