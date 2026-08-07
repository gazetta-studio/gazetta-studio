/**
 * Deterministic gate over lessons-learned.md: flags any `**Signal:** N`
 * header whose per-shape sub-tallies don't sum to N. `compact.ts` runs
 * it after Claude writes the file and fails the run on a violation.
 *
 * Scope is header-vs-sub-tally arithmetic only. A lone Signal count with
 * no sub-tallies is intentionally left alone (see the empty-subtally
 * skip below).
 */

export interface SignalCountViolation {
  header: number
  sum: number
  line: string
}

/** Captures the integer in `**Signal:** 14 ...`; leading indent tolerated. */
const SIGNAL_HEADER = /^\s*\*\*Signal:\*\*\s+(\d+)\b/
/** Captures the count in a `- label (6):` sub-tally; `-`/`*`/`+` bullets. */
const SUB_TALLY = /^\s*[-*+]\s+.*\((\d+)\):/

/**
 * A header's sub-tallies are the `- label (K):` bullets following it, up
 * to the next `**Signal:**` header or the next `##` heading.
 */
export function findSignalCountViolations(markdown: string): SignalCountViolation[] {
  const lines = markdown.split('\n')
  const violations: SignalCountViolation[] = []

  for (let i = 0; i < lines.length; i++) {
    const headerMatch = lines[i].match(SIGNAL_HEADER)
    if (!headerMatch) continue

    const header = Number(headerMatch[1])
    const subTallies: number[] = []

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
