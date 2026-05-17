/**
 * Candidates fence parser — extract audit-area's ranked candidate list
 * from its final assistant text. Mirror of verdict.ts's findings-fence
 * parser but with the candidate schema from design-code-review.md.
 *
 * The schema (per audit-area/SKILL.md "Output — candidates fence"):
 *   - area               (repo-relative path, area-scoped not line-scoped)
 *   - type               (security | architecture | tests | types | comments | style | correctness)
 *   - severity           (CRITICAL | IMPORTANT | NIT)
 *   - summary            (one-sentence forward-looking problem statement)
 *   - suggested_action   (one-sentence starting point Agent A reads)
 *   - confidence         (0-100; ≥80 floor)
 *   - rule               (doc.md[#anchor] | file:line citation)
 */

export type CandidateSeverity = 'CRITICAL' | 'IMPORTANT' | 'NIT'
export type CandidateType = 'security' | 'architecture' | 'tests' | 'types' | 'comments' | 'style' | 'correctness'

export interface Candidate {
  area: string
  type: CandidateType
  severity: CandidateSeverity
  summary: string
  suggested_action: string
  confidence: number
  rule: string
}

const VALID_TYPES = new Set<CandidateType>([
  'security',
  'architecture',
  'tests',
  'types',
  'comments',
  'style',
  'correctness',
])

const VALID_SEVERITIES = new Set<CandidateSeverity>(['CRITICAL', 'IMPORTANT', 'NIT'])

/** Extract the `candidates` fence body from audit-area's final text. */
export function extractCandidatesFence(text: string): string {
  const m = text.match(/```candidates\n([\s\S]*?)\n```/)
  return m?.[1] ?? ''
}

/** Parse the JSONL body into typed Candidate[]. Skips malformed lines. */
export function parseCandidatesFence(fenceBody: string): Candidate[] {
  const out: Candidate[] = []
  for (const line of fenceBody.split('\n')) {
    if (!line.trim()) continue
    try {
      const raw = JSON.parse(line) as Partial<Candidate>
      if (
        typeof raw.area === 'string' &&
        typeof raw.type === 'string' &&
        VALID_TYPES.has(raw.type as CandidateType) &&
        typeof raw.severity === 'string' &&
        VALID_SEVERITIES.has(raw.severity as CandidateSeverity) &&
        typeof raw.summary === 'string' &&
        typeof raw.confidence === 'number'
      ) {
        out.push({
          area: raw.area,
          type: raw.type as CandidateType,
          severity: raw.severity as CandidateSeverity,
          summary: raw.summary,
          suggested_action: raw.suggested_action ?? '',
          confidence: raw.confidence,
          rule: raw.rule ?? '',
        })
      }
    } catch {
      // malformed — skip
    }
  }
  return out
}

/**
 * Sort + filter candidates per Phase 2 of design-code-review.md
 * "Review-bot (autonomous)":
 *
 *   1. Drop confidence < 80 (defensive; skill emits ≥80 already)
 *   2. Sort by severity (CRITICAL=0, IMPORTANT=1, NIT=2) then by
 *      confidence descending
 *   3. Caller applies skip-list filter as a final pass before
 *      picking the top entry (signature accepts a predicate).
 */
export function rankCandidates(
  candidates: readonly Candidate[],
  isSkipped: (c: Candidate) => boolean = () => false,
): Candidate[] {
  const eligible = candidates.filter(c => c.confidence >= 80 && !isSkipped(c))
  const severityRank: Record<CandidateSeverity, number> = { CRITICAL: 0, IMPORTANT: 1, NIT: 2 }
  return [...eligible].sort((a, b) => {
    const sevDelta = severityRank[a.severity] - severityRank[b.severity]
    if (sevDelta !== 0) return sevDelta
    return b.confidence - a.confidence
  })
}
