/**
 * Runs the audit retention pruner with a structured failure signal.
 *
 * # Why a dedicated runner
 *
 * `createAdminApp` schedules `pruneAuditEvents` at boot + every 6
 * hours. Failures must fail-open per Universal Provider Requirement
 * #5 (audit accumulates until the next successful prune; the pruner
 * never blocks admin boot or background work), but silent swallowing
 * leaves operators with no signal that retention has stopped working.
 *
 * The runner adds the operational-signal half of the contract while
 * preserving fail-open behavior: pruneAuditEvents throws → catch →
 * emit a structured log entry → continue (no rethrow).
 *
 * # SOLID lenses
 *
 *   - SRP: this module owns "run the pruner + report failure." The
 *     pruner itself (`audit/retention.ts`) owns retention semantics;
 *     `createAdminApp` owns scheduling.
 *   - DIP: depends on the `StorageProvider` + `AuditRetentionConfig`
 *     interfaces; no direct coupling to the audit module's internals
 *     beyond the existing exported entry point.
 *   - ISP: callers see one function, one option bag. Sink seam is
 *     test-only ergonomics that production callers can ignore.
 *
 * # Why structured JSON via console.error (not gazetta/logging)
 *
 * design-logging.md has shipped as a design pass, but the
 * implementation sits in Tier 3 — `gazetta/logging` doesn't exist
 * yet. The interim convention is the same one cache-stats-logger.ts
 * uses today: emit structured JSON via console with a sink seam for
 * tests. When `gazetta/logging` ships, the defaultFailureSink swaps
 * to a module-scoped pino logger; the public contract is unchanged.
 */
import type { StorageProvider } from '../types.js'
import { pruneAuditEvents, type AuditRetentionConfig } from '../audit/retention.js'

/**
 * Structured failure log shape. Matches the design-logging.md fields
 * (timestamp / level / module / message) plus an `err` object that
 * carries name + message (+ stack when present). No payload — failure
 * logs never carry the event-payload that failed (matches
 * design-audit.md's failure-log-payload-exclusion rule).
 */
export interface AuditPruneFailureLogEntry {
  /** ISO 8601 with Z suffix. */
  timestamp: string
  level: 'error'
  module: 'admin-api.audit-prune'
  message: string
  err: { name: string; message: string; stack?: string }
}

export interface RunAuditPruneOptions {
  storage: StorageProvider
  retentionConfig: AuditRetentionConfig
  /**
   * Sink for failure log entries. Defaults to `console.error` with a
   * stringified JSON payload — matches the cache-stats-logger.ts
   * default. Tests pass a capture function.
   */
  sink?: (entry: AuditPruneFailureLogEntry) => void
}

export async function runAuditPrune(opts: RunAuditPruneOptions): Promise<void> {
  const sink = opts.sink ?? defaultFailureSink
  try {
    await pruneAuditEvents(opts.storage, opts.retentionConfig)
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err))
    sink({
      timestamp: new Date().toISOString(),
      level: 'error',
      module: 'admin-api.audit-prune',
      message: 'Audit retention pruner failed',
      err: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
    })
  }
}

function defaultFailureSink(entry: AuditPruneFailureLogEntry): void {
  console.error(JSON.stringify(entry))
}
