/**
 * Skip-list — durable memory for review-bot's "don't propose this
 * improvement again" decisions.
 *
 * Same two-shape model as dead-code-watcher (entries + rules), but
 * the fingerprint differs: review-bot's fingerprint identifies one
 * candidate improvement (area + type + rule) rather than one knip
 * finding. A candidate fingerprint matches if a prior review-bot
 * PR proposing the SAME improvement was already closed (merged or
 * rejected); the rule keeps the bot from looping on the same
 * candidate forever.
 *
 * Both shapes are read every daily run; a candidate is skipped if
 * EITHER matches. Both are written via PRs (no direct main commits
 * per team-preferences rule 33). The daily bot adds entries; the
 * monthly compactor replaces entries with rules.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/**
 * Fingerprint shape — uniquely identifies one improvement candidate.
 *
 * Derived from audit-area's candidates fence schema:
 *   - area: the path the candidate is scoped to
 *   - type: the angle that surfaced it (security/architecture/tests/...)
 *   - rule: the doc/anchor citation
 *
 * Three fields together are enough to dedupe across runs without
 * collapsing distinct candidates in the same area+type.
 */
export interface Fingerprint {
  area: string
  type: 'security' | 'architecture' | 'tests' | 'types' | 'comments' | 'style' | 'correctness'
  rule: string
}

/** Reason categories — drives downstream filtering + future compaction patterns. */
export type SkipReason =
  /** Maintainer rejected the proposed improvement PR. */
  | 'maintainer-rejected'
  /** Bot tried but the generator-critic loop didn't converge. */
  | 'needs-human'
  /** Bot's Agent A produced a stuck-comment instead of a fix. */
  | 'stuck'
  /** The candidate's area is being actively reworked by another process. */
  | 'in-flight-elsewhere'
  /** Maintainer manually decided this candidate isn't worth fixing. */
  | 'wontfix'
  /** Other — fall-through; reasonNote must explain. */
  | 'other'

export interface SkipEntry {
  fingerprint: Fingerprint
  reason: SkipReason
  /** Free-text explanation. Required when reason='other' or 'maintainer-rejected'. */
  reasonNote?: string
  /** When the entry was added. ISO-8601. */
  addedAt: string
  /** Who decided. Bot = compacted from feedback loop; maintainer = manual edit. */
  addedBy: 'bot' | 'maintainer'
  /** PR number that originated the decision (when addedBy=bot). */
  refPR?: number
}

export interface SkipRule {
  /** Stable identifier for diagnostics + compaction replays. */
  rule: string
  /**
   * Glob pattern matched against the candidate's `area` (path).
   * Same shape as dead-code-watcher's rule globs.
   */
  scope: string
  /**
   * Optional candidate-type filter. When set, rule only matches
   * candidates of these types. When omitted, matches any type.
   */
  types?: Array<Fingerprint['type']>
  /** Reason this scope is skipped (audit trail). */
  reason: SkipReason
  reasonNote?: string
  addedAt: string
  /** Compactor-authored rules link to the entries they generalize. */
  generalizedFrom?: number[]
}

export interface SkipList {
  version: 1
  entries: SkipEntry[]
  rules: SkipRule[]
}

const EMPTY_SKIPLIST: SkipList = { version: 1, entries: [], rules: [] }

export function readSkipList(path: string): SkipList {
  if (!existsSync(path)) return { ...EMPTY_SKIPLIST }
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<SkipList>
  return {
    version: 1,
    entries: raw.entries ?? [],
    rules: raw.rules ?? [],
  }
}

export function writeSkipList(path: string, list: SkipList): void {
  writeFileSync(path, `${JSON.stringify(list, null, 2)}\n`)
}

/** Does this fingerprint match any entry or rule in the skip list? */
export function isSkipped(list: SkipList, fp: Fingerprint): boolean {
  for (const entry of list.entries) {
    if (
      entry.fingerprint.area === fp.area &&
      entry.fingerprint.type === fp.type &&
      entry.fingerprint.rule === fp.rule
    ) {
      return true
    }
  }
  for (const rule of list.rules) {
    if (rule.types && !rule.types.includes(fp.type)) continue
    if (matchGlob(rule.scope, fp.area)) return true
  }
  return false
}

/** Append a new skip entry (idempotent — duplicate fingerprints skipped). */
export function recordSkipListEntry(list: SkipList, fp: Fingerprint, opts: Omit<SkipEntry, 'fingerprint' | 'addedAt' | 'addedBy'>): SkipList {
  if (isSkipped(list, fp)) return list
  return {
    ...list,
    entries: [
      ...list.entries,
      {
        fingerprint: fp,
        addedAt: new Date().toISOString(),
        addedBy: 'bot',
        ...opts,
      },
    ],
  }
}

/**
 * Minimal glob matcher — sufficient for the skip-list use case.
 * Supports `*` (segment) and `**` (any path including separators).
 * Not a general glob library; we only handle the patterns the
 * compactor produces.
 */
export function matchGlob(pattern: string, candidate: string): boolean {
  let regex = ''
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]
    if (c === '*' && pattern[i + 1] === '*') {
      regex += '.*'
      i += 2
      if (pattern[i] === '/') i++
    } else if (c === '*') {
      regex += '[^/]*'
      i++
    } else if (c === '?') {
      regex += '[^/]'
      i++
    } else if (c !== undefined && '.+^${}()|[]\\'.includes(c)) {
      regex += `\\${c}`
      i++
    } else {
      regex += c
      i++
    }
  }
  return new RegExp(`^${regex}$`).test(candidate)
}
