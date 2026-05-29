/**
 * Feature-bot skip-list — durable memory of "don't try this cut sub-issue again."
 *
 * Mirrors fix-bot's skip-list shape but extends the SkipReason union with
 * 4 feature-bot-specific reasons per design-feature-bot.md Q7. The
 * fingerprint shape (`{ issueNumber }`) is identical to fix-bot's because
 * both bots key off GitHub issue numbers — fix-bot reads bug+ready-for-agent
 * issues; feature-bot reads enhancement+ready-for-agent cut sub-issues
 * (per Q1: cuts live in tracking issues + sub-issues; no new labels).
 *
 * Why each bot has its own skip-list module (per team-preferences rule 19,
 * extract shared code when 3+ callers exist): two callers today and the
 * SkipReason unions diverge enough that a generic refactor would touch
 * fix-bot's working v1 for minimal long-term win. Each bot owns its memory
 * so the unions can grow independently.
 *
 * Entries vs (no) rules: feature-bot's skip-list only ships entries in v1.
 * Cuts are unique (one sub-issue per cut); rule-shaped generalizations
 * (matching by label or title-regex) wait until the compactor surfaces
 * concrete demand — feature-bot has ~52 decisions/year, too thin for a
 * v1 compactor (mirroring mutation-area-picker's deferred-compactor
 * rationale).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/**
 * Fingerprint for a feature-bot finding — just the GitHub cut sub-issue number.
 *
 * Stored as a number rather than a string to keep JSON cleaner and
 * to gate against typos (e.g. `"501"` vs `501`).
 */
export interface IssueFingerprint {
  issueNumber: number
}

/**
 * Skip reasons — drive future-cron decisions on the same cut sub-issue.
 *
 * Per design-feature-bot.md Q7 (8 values total):
 *
 *   - 4 values REUSED from fix-bot (Agent B's reviewer runs the same
 *     checks across both bots, so the reason shape is shared):
 *     `needs-human`, `maintainer-rejected`, `tautological-test`,
 *     `wrong-root-cause`
 *
 *   - 4 values ADDED by feature-bot (concrete scenarios surfaced during
 *     Q6 grilling, not speculative):
 *     `missing-prereq` — Agent A found required infrastructure absent
 *         despite closed deps
 *     `spec-too-vague` — cut spec doesn't describe enough for Agent A
 *         to interpret
 *     `input-cycles-exceeded` — MAX_INPUT_REQUESTS=2 hit without
 *         resolution
 *     `files-conflict` — cut's files overlap with another in-flight
 *         cut's open PR
 *
 * Per Q7: typed enum (not free-text) so the future compactor can
 * pattern-match cross-cut failure modes; outcome tags in PR + comment
 * bodies include the reason for forensic queries
 * (`gh issue list --search "feature-bot: skip-entry reason=missing-prereq"`).
 */
export type SkipReason =
  // Reused from fix-bot
  | 'needs-human'
  | 'maintainer-rejected'
  | 'tautological-test'
  | 'wrong-root-cause'
  // Feature-bot additions per Q7
  | 'missing-prereq'
  | 'spec-too-vague'
  | 'input-cycles-exceeded'
  | 'files-conflict'

export interface SkipListEntry {
  fingerprint: IssueFingerprint
  reason: SkipReason
  /** Free-text detail accompanying the typed reason. */
  reasonNote: string
  /** ISO-8601. */
  addedAt: string
  /** Bot = autocaptured from feedback loop; maintainer = manual edit. */
  addedBy: 'bot' | 'maintainer'
  /** The PR number whose closing surfaced this rejection (when addedBy=bot). */
  refPR?: number
}

export interface SkipList {
  version: 1
  entries: SkipListEntry[]
}

/** Disk-storage path relative to repo root. */
export const SKIP_LIST_PATH = 'bots/feature-bot/skip-list.json'

export function emptySkipList(): SkipList {
  return { version: 1, entries: [] }
}

export function readSkipList(absolutePath: string): SkipList {
  if (!existsSync(absolutePath)) return emptySkipList()
  const raw = readFileSync(absolutePath, 'utf-8')
  const parsed = JSON.parse(raw) as SkipList
  if (parsed.version !== 1) {
    throw new Error(`Skip-list at ${absolutePath} has unknown version ${parsed.version}`)
  }
  // Defensive: a hand-edited file or legacy shape may omit entries entirely.
  if (!Array.isArray(parsed.entries)) {
    return { version: 1, entries: [] }
  }
  return parsed
}

export function writeSkipList(absolutePath: string, list: SkipList): void {
  writeFileSync(absolutePath, `${JSON.stringify(list, null, 2)}\n`)
}

/**
 * Match a fingerprint against the skip-list.
 *
 * v1 ships entries only — no rule-shape matching. Cuts are unique enough
 * that per-issue gates are sufficient; rules wait until the compactor
 * earns its place. Mirror the fix-bot ergonomic of returning the matched
 * entry (so callers can render the reason in the skip notice) or null.
 */
export function findSkipMatch(list: SkipList, fp: IssueFingerprint): SkipListEntry | null {
  for (const entry of list.entries) {
    if (entry.fingerprint.issueNumber === fp.issueNumber) return entry
  }
  return null
}

/**
 * Append a fresh entry. Idempotent: if an entry with the same issue
 * number already exists, the existing one is kept unchanged and the
 * call returns false. Mirrors fix-bot's contract so symmetric audits
 * (rule 38) compose cleanly.
 */
export function appendEntry(list: SkipList, entry: SkipListEntry): boolean {
  const existing = list.entries.find(e => e.fingerprint.issueNumber === entry.fingerprint.issueNumber)
  if (existing) return false
  list.entries.push(entry)
  return true
}
