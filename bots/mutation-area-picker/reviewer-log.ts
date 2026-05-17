/**
 * Reviewer-log — durable record of every decision the
 * mutation-area-picker makes.
 *
 * Append-only JSONL (`bots/mutation-area-picker/reviewer-log.jsonl`).
 * One line per cron run: ADD, SWAP, REMOVE, or NOOP. Persists across
 * runs via `actions/cache@v4` (ADR-0011 pattern). The monthly
 * compactor reads recent entries and produces
 * `lessons-learned.md` patterns.
 *
 * Why per-bot, not shared `_lib`: per the project's "bots should have
 * separate memory" rule. The action enum + payload shape are
 * mutation-area-picker-specific; sharing would force a generic
 * `payload: unknown` type that loses information.
 *
 * NOTE: there is no Agent A / Agent B reviewer-loop here — the
 * decision is computed deterministically in the orchestrator. The
 * file is called `reviewer-log` for symmetry with the rest of the
 * bot ecosystem and because the empirical signals (Stryker results,
 * mutation-watcher fix-rates) ARE the implicit reviewers; each entry
 * records "what did the bot decide, with what evidence."
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

export type DecisionAction = 'add' | 'swap' | 'remove' | 'noop'

export interface ReviewerLogEntry {
  ts: string
  runId: string
  action: DecisionAction
  /** Module being added (ADD / SWAP) — null for REMOVE / NOOP. */
  addedModule: string | null
  /** Module being removed (REMOVE / SWAP) — null for ADD / NOOP. */
  removedModule: string | null
  /** Top inclusion score the bot saw this run (regardless of action). */
  topInclusionScore: number
  /** Worst (highest) eviction score among scoped modules — i.e. closest to graduating. */
  worstEvictionScore: number
  /** Estimated runtime cost in minutes after applying this decision (current + delta). */
  estimatedRuntimeAfterMinutes: number
  /** Human-readable summary of which rule fired. */
  reasoning: string
  /** Bootstrap week (1-4) when eviction logic is disabled; null afterwards. */
  bootstrapWeek: number | null
}

export function appendReviewerLog(absolutePath: string, entry: ReviewerLogEntry): void {
  appendFileSync(absolutePath, `${JSON.stringify(entry)}\n`)
}

export function readReviewerLog(absolutePath: string): ReviewerLogEntry[] {
  if (!existsSync(absolutePath)) return []
  const raw = readFileSync(absolutePath, 'utf-8')
  const entries: ReviewerLogEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      entries.push(JSON.parse(line) as ReviewerLogEntry)
    } catch {
      // malformed — skip
    }
  }
  return entries
}

export function tailReviewerLog(absolutePath: string, n: number): ReviewerLogEntry[] {
  return readReviewerLog(absolutePath).slice(-n)
}

/**
 * Count distinct weekly run timestamps. Used to determine the
 * bootstrap-week counter (first 4 weeks: ADD-only, no eviction).
 *
 * "Distinct week" is approximated by counting unique YYYY-MM-DD
 * dates spanning >= 6 days from the oldest — protects against
 * accidental multiple runs in one day inflating the count.
 */
export function countWeeklyRuns(entries: ReviewerLogEntry[]): number {
  if (entries.length === 0) return 0
  const days = new Set(entries.map(e => e.ts.slice(0, 10)))
  return days.size
}

/**
 * Truncate the file to the last `keepLast` entries. Mirrors
 * dead-code-watcher's pruneReviewerLog — the compactor calls this
 * after producing its lessons rewrite to keep the cached file
 * bounded.
 */
export function pruneReviewerLog(absolutePath: string, keepLast: number): { dropped: number; kept: number } {
  const all = readReviewerLog(absolutePath)
  if (all.length <= keepLast) return { dropped: 0, kept: all.length }
  const kept = all.slice(-keepLast)
  writeFileSync(absolutePath, `${kept.map(e => JSON.stringify(e)).join('\n')}\n`)
  return { dropped: all.length - keepLast, kept: kept.length }
}

export const REVIEWER_LOG_PATH = 'bots/mutation-area-picker/reviewer-log.jsonl'
