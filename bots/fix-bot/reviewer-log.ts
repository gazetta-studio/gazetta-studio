/**
 * Reviewer-log — durable record of every Agent B verdict for fix-bot.
 *
 * Append-only JSONL (`bots/fix-bot/reviewer-log.jsonl`). One line per
 * Agent B verdict: APPROVE, REJECT, or NEEDS_HUMAN. Persists the
 * reviewer's reasoning so the monthly compactor can surface
 * cross-issue patterns into lessons-learned.md.
 *
 * Distinct from skip-list (per-issue rejection memory, gates future
 * runs) and lessons-learned.md (compacted prose loaded into Agent
 * A's prompt). The reviewer-log is the RAW SIGNAL the compactor
 * reads to produce lessons.
 *
 * Why per-bot: bot-specific fingerprint shape (`{issueNumber}` here,
 * knip Fingerprint in dead-code-watcher) — same rule as skip-list.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { IssueFingerprint } from './skip-list.js'

export interface ReviewerLogEntry {
  ts: string
  runId: string
  fingerprint: IssueFingerprint
  fingerprintLabel: string
  attempt: number
  verdict: 'approve' | 'reject' | 'needs-human'
  reasoning: string
  agentASummary: string
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
 * Truncate the file to the last `keepLast` entries — the compactor
 * calls this AFTER producing its lessons-learned rewrite, so the
 * cached file stays bounded across months. Old entries are
 * intentionally dropped; per ADR-0011 (cache-based persistence),
 * a future artifact-upload path is the place for raw-history
 * preservation if it ever earns its keep.
 */
export function pruneReviewerLog(absolutePath: string, keepLast: number): { dropped: number; kept: number } {
  const all = readReviewerLog(absolutePath)
  if (all.length <= keepLast) return { dropped: 0, kept: all.length }
  const kept = all.slice(-keepLast)
  writeFileSync(absolutePath, `${kept.map(e => JSON.stringify(e)).join('\n')}\n`)
  return { dropped: all.length - keepLast, kept: kept.length }
}

export const REVIEWER_LOG_PATH = 'bots/fix-bot/reviewer-log.jsonl'
