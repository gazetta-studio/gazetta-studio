/**
 * decision-log.jsonl — cut-planner's raw memory tier (design-cut-planner.md
 * Q7a).
 *
 * One entry per run that examined at least one planner issue: the per-
 * feature decisions, and the one action taken (or why none was). The
 * monthly compactor distils these into `lessons-learned.md`; this file is
 * raw signal, not guidance, and is never loaded into a planning prompt.
 *
 * Persisted via actions/cache (restore/save split, per-run key), NOT
 * committed: losing it on a cache miss costs one compaction window, not
 * correctness (ADR-0011). Same shape as the other bots' reviewer-log
 * helpers; each bot owns its own copy because the entry types differ.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

export const DECISION_LOG_PATH = 'bots/cut-planner/decision-log.jsonl'

export interface DecisionLogEntry {
  /** ISO timestamp. */
  at: string
  runId: string
  /** What the dispatcher decided for each planner issue examined this run. */
  decisions: { planner: number; feature: string; decision: string }[]
  /** How the run ended. */
  outcome: 'acted' | 'idle' | 'quota-stop' | 'budget-stop'
  /** Present when `outcome` is `acted`: what was done, and for which feature. */
  action?: { planner: number; feature: string; summary: string }
}

export function appendDecisionLog(absolutePath: string, entry: DecisionLogEntry): void {
  appendFileSync(absolutePath, `${JSON.stringify(entry)}\n`)
}

function readDecisionLog(absolutePath: string): DecisionLogEntry[] {
  if (!existsSync(absolutePath)) return []
  const entries: DecisionLogEntry[] = []
  for (const line of readFileSync(absolutePath, 'utf-8').split('\n')) {
    if (!line.trim()) continue
    try {
      entries.push(JSON.parse(line) as DecisionLogEntry)
    } catch {
      // malformed — a partial write or an older schema; skip, don't crash
    }
  }
  return entries
}

export function tailDecisionLog(absolutePath: string, n: number): DecisionLogEntry[] {
  return readDecisionLog(absolutePath).slice(-n)
}

/**
 * Truncate to the last `keepLast` entries. Called by the compactor only
 * AFTER a successful lessons rewrite, so a failed compaction never evicts
 * the input its retry will need.
 */
export function pruneDecisionLog(absolutePath: string, keepLast: number): { dropped: number; kept: number } {
  const all = readDecisionLog(absolutePath)
  if (all.length <= keepLast) return { dropped: 0, kept: all.length }
  const kept = all.slice(-keepLast)
  writeFileSync(absolutePath, `${kept.map(e => JSON.stringify(e)).join('\n')}\n`)
  return { dropped: all.length - keepLast, kept: kept.length }
}
