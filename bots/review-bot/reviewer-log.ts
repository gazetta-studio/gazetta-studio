/**
 * Reviewer-log — durable record of every Agent B verdict for review-bot.
 *
 * Append-only JSONL (`bots/review-bot/reviewer-log.jsonl`). One line
 * per Agent B verdict on a proposed improvement: APPROVE, REJECT, or
 * NEEDS_HUMAN. Persists the reviewer's reasoning so the monthly
 * compactor can surface cross-candidate patterns into lessons-learned.md.
 *
 * Same shape as fix-bot's reviewer-log; the fingerprint differs
 * (Fingerprint from skip-list.ts — area + type + rule) because
 * review-bot's bot-output unit is a candidate, not an issue.
 *
 * Persistence: actions/cache@v4 keyed `review-bot-reviewer-log-v1`
 * per ADR-0011. Single-instance invariant via concurrency group.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { Fingerprint } from './skip-list.js'

export interface ReviewerLogEntry {
  ts: string
  runId: string
  fingerprint: Fingerprint
  /** Short human-readable fingerprint label (area + type) for log scanning. */
  fingerprintLabel: string
  /** Attempt number within this candidate's generator-critic loop (1-N). */
  attempt: number
  verdict: 'approve' | 'reject' | 'needs-human'
  /** Reviewer's free-text reasoning. */
  reasoning: string
  /** One-line summary of what Agent A produced. */
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
      // malformed — skip; old schema or partial write
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
 * intentionally dropped; per ADR-0011, raw history preservation
 * (artifact-upload path) is deferred until concrete demand surfaces.
 */
export function pruneReviewerLog(absolutePath: string, keepLast: number): { dropped: number; kept: number } {
  const all = readReviewerLog(absolutePath)
  if (all.length <= keepLast) return { dropped: 0, kept: all.length }
  const kept = all.slice(-keepLast)
  writeFileSync(absolutePath, `${kept.map((e) => JSON.stringify(e)).join('\n')}\n`)
  return { dropped: all.length - keepLast, kept: kept.length }
}

export const REVIEWER_LOG_PATH = 'bots/review-bot/reviewer-log.jsonl'
