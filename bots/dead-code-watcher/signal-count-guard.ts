/**
 * Deterministic post-generation gate for lessons-learned.md.
 *
 * The monthly compactor (`compact.ts`) lets Claude write
 * lessons-learned.md directly. In run #686 Claude authored a
 * `**Signal:** 14 ...` header whose per-shape sub-tallies summed to
 * 13; a later compaction (#688) had to self-correct it a month on.
 *
 * This guard makes that class of drift impossible to SHIP: after
 * Claude writes the file, `compact.ts` parses it and fails the run
 * (non-zero exit) if any Signal header disagrees with the sum of its
 * per-shape sub-tallies. The prompt instruction is the belt; this
 * code gate is the suspenders — and the load-bearing half, because
 * the prompt instruction is exactly what the LLM ignored.
 *
 * Scope (per design-self-learning.md, Y-now-X-later): this checks
 * header-vs-sub-tally arithmetic only — the one drift actually
 * observed. A lone Signal count with no sub-tallies has nothing to
 * cross-check and is left alone; if a lone count ever drifts, that's
 * the evidence to justify the larger code-renders-the-file
 * restructure (option X).
 */

export interface SignalCountViolation {
  /** The number stated in the `**Signal:** N ...` header. */
  header: number
  /** Sum of the per-shape sub-tally counts under that header. */
  sum: number
  /** The header line, for the failure message. */
  line: string
}

/**
 * Matches `**Signal:** 14 ...` — captures the leading integer.
 * Leading whitespace is tolerated: Claude authors this file freely and
 * may indent, and a false-clean (drift slips past the gate) is the worst
 * failure mode for a guard, so the matchers accept plausible LLM
 * formatting variants rather than the strictest possible shape.
 */
const SIGNAL_HEADER = /^\s*\*\*Signal:\*\*\s+(\d+)\b/
/**
 * Matches a sub-tally bullet `- <label> (6): ...` — captures the count.
 * Accepts `-`, `*`, and `+` bullet markers (Markdown permits all three).
 */
const SUB_TALLY = /^\s*[-*+]\s+.*\((\d+)\):/

/**
 * Find every Signal header whose per-shape sub-tallies don't sum to
 * the header count. Returns one violation per offending header;
 * empty when the file is consistent (or has no cross-checkable
 * headers).
 *
 * A header's sub-tallies are the `- label (K):` bullets that follow
 * it, up to the next `**Signal:**` header or the next `##` heading.
 */
export function findSignalCountViolations(markdown: string): SignalCountViolation[] {
  const lines = markdown.split('\n')
  const violations: SignalCountViolation[] = []

  for (let i = 0; i < lines.length; i++) {
    const headerMatch = lines[i].match(SIGNAL_HEADER)
    if (!headerMatch) continue

    const header = Number(headerMatch[1])
    const subTallies: number[] = []

    // Scan forward for this header's sub-tally bullets, stopping at
    // the next Signal header or the next section heading.
    for (let j = i + 1; j < lines.length; j++) {
      if (SIGNAL_HEADER.test(lines[j]) || lines[j].startsWith('## ')) break
      const tallyMatch = lines[j].match(SUB_TALLY)
      if (tallyMatch) subTallies.push(Number(tallyMatch[1]))
    }

    // No sub-tallies → nothing to cross-check (lone count, out of scope).
    if (subTallies.length === 0) continue

    const sum = subTallies.reduce((a, b) => a + b, 0)
    if (sum !== header) {
      violations.push({ header, sum, line: lines[i] })
    }
  }

  return violations
}
