/**
 * User-agent recording — opt-in per design-audit.md "User agent
 * recording" section. Lower priority than source-IP; most operators
 * don't enable.
 *
 * # Modes
 *
 *   - `'none'` (default) — UA not recorded; field absent
 *   - `'raw'` — full UA string. Useful for fingerprint forensics
 *   - `'truncated'` — browser family + major version. Drops
 *     fingerprinting detail; example outputs: `'Chrome/119'`,
 *     `'Firefox/120'`, `'Safari/17'`, `'Other'`
 *
 * No `'hashed'` mode — UA has too little entropy for hashing to be
 * a meaningful privacy hardening; if you want privacy, use
 * `truncated` or `none`.
 *
 * # SOLID lenses
 *
 *   - SRP: UA processing only.
 */

export type UserAgentMode = 'none' | 'raw' | 'truncated'

/**
 * Apply the configured UA mode. Returns null for `'none'` or when
 * input is empty/missing.
 */
export function processUserAgent(rawUa: string | undefined, mode: UserAgentMode): string | null {
  if (mode === 'none') return null
  if (!rawUa || rawUa.length === 0) return null
  if (mode === 'raw') return rawUa
  // mode === 'truncated' — extract browser family + major version.
  return truncateUserAgent(rawUa)
}

/**
 * Heuristic browser-family detection. Order matters: Edge before
 * Chrome (Edge UA contains Chrome); Opera before Chrome (same).
 * Returns 'Other' when no known family matches — better than
 * leaking the raw string under truncated mode.
 */
function truncateUserAgent(ua: string): string {
  // Patterns ordered by specificity: more-specific first.
  const patterns: Array<{ name: string; regex: RegExp }> = [
    { name: 'Edge', regex: /Edg(e|A|iOS)?\/(\d+)/i },
    { name: 'Opera', regex: /OPR\/(\d+)/i },
    { name: 'Chrome', regex: /Chrome\/(\d+)/i },
    { name: 'Firefox', regex: /Firefox\/(\d+)/i },
    { name: 'Safari', regex: /Version\/(\d+).*Safari/i },
  ]
  for (const { name, regex } of patterns) {
    const match = ua.match(regex)
    if (match) {
      // Match group 1 is sometimes a sub-product name (Edg vs Edge),
      // group 2 is the version. Pick the last numeric group.
      const numericGroups = match.filter(g => /^\d+$/.test(g ?? ''))
      const version = numericGroups[numericGroups.length - 1]
      return `${name}/${version}`
    }
  }
  return 'Other'
}
