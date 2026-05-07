/**
 * Audit retention pruner.
 *
 * Per design-audit.md "Retention": audit retention is configurable
 * independently from content history retention. Two dimensions:
 *
 *   - `events` — max event count kept across all per-instance JSONL
 *     files. When exceeded, oldest events evicted (timestamp-sort
 *     ascending; drop from the head).
 *   - `maxAgeMonths` — max age in months. Events older than the
 *     cutoff evicted regardless of count.
 *
 * Operator sets one or both. When neither set, the pruner is a no-op
 * (audit accumulates indefinitely until storage budget exhausted —
 * operator's choice; documented).
 *
 * # JSONL storage shape
 *
 * Per `HistoryAuditProvider`, events live in
 * `.gazetta/audit/events-{instance-id}.jsonl` — one file per admin
 * instance. The pruner walks every events file, parses lines into
 * AuditEvent objects, applies retention, and rewrites each file with
 * the surviving lines. Per-file rewrite preserves the per-instance
 * scoping (no cross-instance interleaving).
 *
 * # Multi-instance correctness
 *
 * Per-revision file granularity (each instance's file is independent)
 * means concurrent pruners on the same target converge. If instance A
 * is rewriting events-A.jsonl while instance B is rewriting
 * events-B.jsonl, no race. If two pruners on different hosts try to
 * rewrite the SAME events-A.jsonl simultaneously (two instances with
 * the same hostname / K_REVISION), the storage provider's atomic
 * write-then-rename keeps the file consistent — last-write-wins is
 * fine because both pruners compute the same surviving set from the
 * same input bytes.
 *
 * # Why JSONL-line pruning, not whole-file deletion
 *
 * The pruner has to handle events file-by-file because:
 *   - Different instances have different event mixes; deleting an
 *     entire instance's file would lose events newer than the cutoff
 *   - Events within one instance's file span time; some pruned, some
 *     kept — selective line removal is the right granularity
 *
 * # Returns: PruneResult
 *
 * Diagnostic info for the caller's log + metrics. `eventsKept` and
 * `eventsEvicted` together = total events pre-prune.
 *
 * # SOLID lenses
 *
 *   - SRP: retention only; doesn't construct providers, doesn't
 *     audit pruner-events itself (would create recursion).
 *   - DIP: takes a StorageProvider — works against filesystem, R2,
 *     S3, Azure Blob uniformly.
 */
import type { StorageProvider } from '../types.js'
import type { AuditEvent } from './types.js'

export interface AuditRetentionConfig {
  /** Max event count kept. When exceeded, oldest evicted. */
  events?: number
  /** Max age in months. Events older than the cutoff evicted. */
  maxAgeMonths?: number | null
}

export interface PruneResult {
  /** Number of events present before pruning. */
  eventsBefore: number
  /** Number of events surviving. */
  eventsKept: number
  /** Number of events evicted. */
  eventsEvicted: number
  /** Files rewritten (only files with at least one eviction). */
  filesRewritten: number
  /** Files inspected (every events file under .gazetta/audit/). */
  filesInspected: number
}

const AUDIT_DIR = '.gazetta/audit'

/**
 * Walk the audit JSONL files, evict events that violate retention,
 * rewrite each affected file. No-op when retention config has neither
 * `events` nor `maxAgeMonths` set.
 */
export async function pruneAuditEvents(storage: StorageProvider, config: AuditRetentionConfig): Promise<PruneResult> {
  // No retention configured → no-op. Operator opted out or never opted in.
  const hasEventsCap = config.events !== undefined && config.events !== null
  const hasAgeCap = config.maxAgeMonths !== undefined && config.maxAgeMonths !== null && config.maxAgeMonths > 0
  if (!hasEventsCap && !hasAgeCap) {
    return { eventsBefore: 0, eventsKept: 0, eventsEvicted: 0, filesRewritten: 0, filesInspected: 0 }
  }

  // Compute the age cutoff once so all files use the same boundary.
  // `maxAgeMonths` is a real-month subtraction (Date.setMonth handles
  // leap years + variable month length); ISO-8601 string compare works
  // on the resulting timestamp.
  const ageCutoff = hasAgeCap ? computeAgeCutoff(config.maxAgeMonths!) : null

  // Walk the events directory. Missing dir = no events to prune.
  let entries: Awaited<ReturnType<StorageProvider['readDir']>>
  try {
    entries = await storage.readDir(AUDIT_DIR)
  } catch {
    return { eventsBefore: 0, eventsKept: 0, eventsEvicted: 0, filesRewritten: 0, filesInspected: 0 }
  }

  // Read every events file into memory with its source path. We need
  // the global event count for `events` cap enforcement (oldest-across-
  // files evicted, not per-file), so we collect all events first.
  const filesInspected: { path: string; events: AuditEvent[]; rawLineCount: number }[] = []
  for (const entry of entries) {
    if (entry.isDirectory) continue
    if (!entry.name.startsWith('events-') || !entry.name.endsWith('.jsonl')) continue
    const path = `${AUDIT_DIR}/${entry.name}`
    const content = await storage.readFile(path)
    const lines = content.split('\n')
    const events: AuditEvent[] = []
    let rawLineCount = 0
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      rawLineCount++
      try {
        events.push(JSON.parse(trimmed) as AuditEvent)
      } catch {
        // Malformed line — skip + count as raw line so the rewrite
        // doesn't accidentally include it. Same posture as the reader
        // in HistoryAuditProvider.
      }
    }
    filesInspected.push({ path, events, rawLineCount })
  }

  const eventsBefore = filesInspected.reduce((sum, f) => sum + f.events.length, 0)
  if (eventsBefore === 0) {
    return {
      eventsBefore: 0,
      eventsKept: 0,
      eventsEvicted: 0,
      filesRewritten: 0,
      filesInspected: filesInspected.length,
    }
  }

  // Phase 1: age cutoff (per-file evaluation; events older than the
  // cutoff are evicted regardless of where they sit in the global
  // ordering).
  for (const file of filesInspected) {
    if (ageCutoff !== null) {
      file.events = file.events.filter(e => e.timestamp >= ageCutoff)
    }
  }

  // Phase 2: count cap (global). Build the global ordering once:
  // sort all surviving events by timestamp (oldest first), evict
  // from the head until we're under the cap. The eviction set is
  // matched back to its source file by reference identity.
  let evictedFromCap = new Set<AuditEvent>()
  if (hasEventsCap) {
    const allSurviving: { file: (typeof filesInspected)[number]; event: AuditEvent }[] = []
    for (const file of filesInspected) {
      for (const event of file.events) {
        allSurviving.push({ file, event })
      }
    }
    allSurviving.sort((a, b) => a.event.timestamp.localeCompare(b.event.timestamp))
    const overflow = allSurviving.length - config.events!
    if (overflow > 0) {
      evictedFromCap = new Set(allSurviving.slice(0, overflow).map(x => x.event))
    }
  }

  // Phase 3: rewrite each file whose surviving set differs from the
  // pre-prune set. Reasons a file rewrites:
  //   - age-cutoff already mutated `file.events`
  //   - count-cap is going to evict additional events
  //   - malformed JSONL lines on disk (rawLineCount > parsed events) —
  //     incidental hygiene; the line never made it through parse and
  //     wouldn't survive a re-read either, so we drop it during the
  //     rewrite. Doesn't count toward `eventsEvicted` (the metric
  //     reports parsed-event deltas only).
  let filesRewritten = 0
  let eventsKeptTotal = 0
  for (const file of filesInspected) {
    const surviving = evictedFromCap.size > 0 ? file.events.filter(e => !evictedFromCap.has(e)) : file.events
    eventsKeptTotal += surviving.length
    const parsedDelta = file.events.length - surviving.length
    const malformedLines = file.rawLineCount - file.events.length
    if (parsedDelta === 0 && malformedLines === 0) continue
    // Rewrite. JSONL convention: one event per line + trailing newline.
    // Empty file (all events pruned) → write an empty string so the
    // file remains as a marker (deleting would force concurrent
    // appenders to mkdir; safer to keep the file with a zero-line body).
    const rewritten = surviving.map(e => JSON.stringify(e)).join('\n')
    const final = rewritten ? rewritten + '\n' : ''
    await storage.writeFile(file.path, final)
    filesRewritten++
  }

  return {
    eventsBefore,
    eventsKept: eventsKeptTotal,
    eventsEvicted: eventsBefore - eventsKeptTotal,
    filesRewritten,
    filesInspected: filesInspected.length,
  }
}

/**
 * Subtract `months` calendar months from `now` and return the ISO
 * timestamp boundary. Events with `timestamp >= cutoff` are kept;
 * older events evicted.
 *
 * Uses Date.setMonth so leap years and variable-length months are
 * handled correctly (3 months back from 2026-05-31 is 2026-02-28,
 * not 2026-02-31).
 */
function computeAgeCutoff(months: number): string {
  const cutoff = new Date()
  cutoff.setMonth(cutoff.getMonth() - months)
  return cutoff.toISOString()
}
