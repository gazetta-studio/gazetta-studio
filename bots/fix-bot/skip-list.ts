/**
 * Fix-bot skip-list — durable memory of "don't try this issue again."
 *
 * Same architectural shape as dead-code-watcher's skip-list, with a
 * different fingerprint type: the identity is an issue number, not
 * a knip finding.
 *
 * Why duplicated instead of generic: per [team-preferences rule 19]
 * (extract shared code when 3+ callers exist), we have two callers
 * now and the type differs enough that a generic refactor would
 * touch dead-code-watcher's working v1 for minimal long-term win.
 * Each bot owns its own skip-list module so the schemas can diverge
 * without one bot's memory bleeding into another's.
 *
 * Entries vs rules:
 *
 *   - **entries**: specific `{ issueNumber, reason, ... }` per-issue
 *     decisions. Most fix-bot skip-list entries are this shape;
 *     issues are unique enough that compaction usually doesn't help.
 *
 *   - **rules**: compacted generalizations the monthly compact-bot
 *     produces. Each has a `scope` matcher (a regex against issue
 *     titles or labels) and matches ANY issue satisfying it. Rules
 *     are rare for fix-bot — most rejections are per-issue, not
 *     per-issue-shape.
 *
 * Lessons-learned (the cross-run pattern memory) lives in
 * `bots/fix-bot/lessons-learned.md` and is loaded by Agent A's
 * prompt directly. Skip-list is the per-issue gate; lessons-learned
 * is the cross-issue wisdom. Different files, different update
 * cadences.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/**
 * Fingerprint for a fix-bot finding — just the GitHub issue number.
 *
 * Stored as a number rather than a string to keep JSON cleaner and
 * to gate against typos (e.g. `"100"` vs `100`).
 */
export interface IssueFingerprint {
  issueNumber: number
}

/** Reason categories — drive Agent A's decision tree on subsequent runs. */
export type SkipReason =
  /** Maintainer rejected the fix-bot PR with reasoning. */
  | 'maintainer-rejected'
  /** Bot tried, tests passed but reviewer (Agent B) caught tautological test. */
  | 'tautological-test'
  /** Reviewer judged the fix addresses a symptom, not the issue's root cause. */
  | 'wrong-root-cause'
  /** Bot tried, couldn't write a failing test (the existing stuck-comment path). */
  | 'needs-human'
  /** Issue is marked won't-fix or otherwise out-of-scope. */
  | 'out-of-scope'
  /** Other — free-text required in reasonNote. */
  | 'other'

export interface SkipEntry {
  fingerprint: IssueFingerprint
  reason: SkipReason
  reasonNote: string
  /** ISO-8601. */
  addedAt: string
  /** Bot = autocaptured from feedback loop; maintainer = manual edit. */
  addedBy: 'bot' | 'maintainer'
  /** The PR number whose closing surfaced this rejection (when addedBy=bot). */
  refPR?: number
}

/**
 * Pattern rules. Less commonly used by fix-bot than dead-code-watcher
 * because issue rejections tend to be per-issue, not per-shape. Still
 * supported for cases like "any issue with label `area: deploy`" if
 * the maintainer wants to permanently route that area away from
 * fix-bot.
 */
export interface SkipRule {
  rule: string
  /**
   * Either a label name to match against the issue's labels, or
   * a regex (anchored with `re:` prefix) against the issue title.
   * Examples:
   *   - `area: deploy` — matches any issue with that exact label
   *   - `re:^Flaky e2e:` — matches issues whose title starts that way
   */
  scope: string
  reason: SkipReason
  reasonNote: string
  addedAt: string
  addedBy: 'bot'
  compactedFrom: number
}

export interface SkipList {
  version: 1
  entries: SkipEntry[]
  rules: SkipRule[]
}

/** Disk-storage path relative to repo root. */
export const SKIP_LIST_PATH = 'bots/fix-bot/skip-list.json'

export function emptySkipList(): SkipList {
  return { version: 1, entries: [], rules: [] }
}

export function readSkipList(absolutePath: string): SkipList {
  if (!existsSync(absolutePath)) return emptySkipList()
  const raw = readFileSync(absolutePath, 'utf-8')
  const parsed = JSON.parse(raw) as SkipList
  if (parsed.version !== 1) {
    throw new Error(`Skip-list at ${absolutePath} has unknown version ${parsed.version}`)
  }
  return parsed
}

export function writeSkipList(absolutePath: string, list: SkipList): void {
  writeFileSync(absolutePath, `${JSON.stringify(list, null, 2)}\n`)
}

/**
 * Match a finding's fingerprint against the skip-list.
 *
 * Checks entries (exact issue-number match) first, then rules
 * (label or title-regex match against the supplied issue
 * metadata). Returns the first match found.
 *
 * Rules need access to the issue's labels + title, which the
 * orchestrator looks up before calling this. We pass them in
 * rather than re-querying GitHub here.
 */
export function findSkipMatch(
  list: SkipList,
  fp: IssueFingerprint,
  issueContext: { title: string; labels: readonly string[] },
): SkipEntry | SkipRule | null {
  for (const entry of list.entries) {
    if (entry.fingerprint.issueNumber === fp.issueNumber) return entry
  }
  for (const rule of list.rules) {
    if (matchesRule(rule.scope, issueContext)) return rule
  }
  return null
}

/**
 * Rule scope matcher. Two forms:
 *   - `re:<pattern>` → regex against the issue title
 *   - anything else → label equality against the issue's label set
 */
export function matchesRule(scope: string, ctx: { title: string; labels: readonly string[] }): boolean {
  if (scope.startsWith('re:')) {
    const pattern = scope.slice(3)
    try {
      return new RegExp(pattern).test(ctx.title)
    } catch {
      // Malformed regex — never matches (don't crash the bot).
      return false
    }
  }
  return ctx.labels.includes(scope)
}

/**
 * Append a fresh entry. Idempotent: if an entry with the same issue
 * number already exists, the existing one is kept unchanged.
 */
export function appendEntry(list: SkipList, entry: SkipEntry): boolean {
  const existing = list.entries.find(e => e.fingerprint.issueNumber === entry.fingerprint.issueNumber)
  if (existing) return false
  list.entries.push(entry)
  return true
}
