/**
 * Reviewer-log — durable record of every Agent B verdict for
 * dead-code-watcher.
 *
 * Append-only JSONL (`bots/dead-code-watcher/reviewer-log.jsonl`).
 * One line per Agent B verdict: APPROVE, REJECT, or NEEDS_HUMAN.
 * Persists the reviewer's reasoning so the monthly compactor can
 * surface cross-run patterns into lessons-learned.md.
 *
 * Distinct from skip-list (per-fingerprint rejection memory, gates
 * future runs) and lessons-learned.md (compacted prose loaded into
 * Agent A's prompt). The reviewer-log is the RAW SIGNAL the
 * compactor reads to produce lessons.
 *
 * Why per-bot, not shared `_lib`: per the project's "bots should
 * have separate memory" rule. fix-bot has its own peer module with
 * its own fingerprint shape. Helper functions read/write/tail are
 * a few lines duplicated; the duplication is cheap and the memory
 * boundary is the load-bearing constraint.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import type { Fingerprint } from './skip-list.js'

export interface ReviewerLogEntry {
  /** ISO-8601 timestamp of the verdict. */
  ts: string
  /** GitHub Actions run ID (or 'local' for local invocation). */
  runId: string
  /** dead-code-watcher's knip fingerprint identifying what was reviewed. */
  fingerprint: Fingerprint
  /** Human-readable label (e.g. "file:src/foo.ts"). */
  fingerprintLabel: string
  /** Generator-critic loop iteration (1..MAX_ATTEMPTS). */
  attempt: number
  /** Reviewer's verdict. */
  verdict: 'approve' | 'reject' | 'needs-human'
  /** Reviewer's reasoning paragraph. */
  reasoning: string
  /** Agent A's claimed summary at the time of this verdict. */
  agentASummary: string
}

/** Append one verdict to the reviewer-log. Fire-and-forget. */
export function appendReviewerLog(absolutePath: string, entry: ReviewerLogEntry): void {
  appendFileSync(absolutePath, `${JSON.stringify(entry)}\n`)
}

/** Read the entire reviewer-log; tolerates malformed lines + missing file. */
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

/** Return the most recent N entries. Used by the compactor to bound input size. */
export function tailReviewerLog(absolutePath: string, n: number): ReviewerLogEntry[] {
  return readReviewerLog(absolutePath).slice(-n)
}

export const REVIEWER_LOG_PATH = 'bots/dead-code-watcher/reviewer-log.jsonl'
