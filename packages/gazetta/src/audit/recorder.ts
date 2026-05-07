/**
 * Audit-recording dispatcher. The fan-out + fail-open layer that
 * separates recording sites (save/publish/delete/restore handlers)
 * from individual `AuditProvider` implementations.
 *
 * # Locked design — synchronous fail-open, parallel fan-out
 *
 * Per `design-audit.md`'s "Recording timing":
 *
 *   - **Synchronous** — operation awaits the audit attempt. If the
 *     user got a success response, the audit attempt was completed.
 *     Async queuing would lose in-flight events on process restart.
 *   - **Fail-open by default** — provider failures never block the
 *     write. Operators in compliance contexts opt into `strict: true`
 *     (any provider failure blocks the write).
 *   - **Parallel fan-out** — `Promise.allSettled` so two providers'
 *     latencies don't stack. Failures are independent.
 *
 * # Failure log — no payload
 *
 * Per Universal Provider Requirement #5: "When audit recording fails
 * (fail-open), the failure log entry MUST NOT contain event payload."
 * The recorder logs only `{ provider, eventId, category }` — never
 * the actor, scope, or metadata. Prevents PII side-channels into
 * application stderr / log shipping.
 *
 * # Strict mode
 *
 * For HIPAA / SOC 2 compliance contexts where "audit recording
 * confirmed successful" is a hard prerequisite for the write to
 * proceed. The recorder's caller (Cut 5's wired handlers) checks
 * the `failed` flag in the result and aborts the write when strict
 * mode is on.
 *
 * # SOLID lenses
 *
 *   - SRP: dispatch + failure-log only. Doesn't construct providers,
 *     doesn't extract identity (Cut 4 handles privacy / source-IP
 *     extraction).
 *   - DIP: takes a `readonly AuditProvider[]` and an opaque logger
 *     callback; no coupling to specific providers or to Hono.
 */
import type { AuditEvent } from './types.js'
import type { AuditProvider } from './provider.js'

export interface AuditFailureLog {
  /** Provider name that failed. Per design: log identifies which sink dropped. */
  provider: string
  /**
   * Categorical reason — `transport` for network/HTTP failures,
   * `serialize` for unparseable events, `quota` for sink full.
   * Surface to log aggregators for filtering.
   */
  category: 'transport' | 'serialize' | 'quota'
  /** Reason text for diagnostics. PII-free; never the event payload. */
  reason: string
}

/**
 * Logger callback signature. Production wires to `pino` per
 * `design-logging.md`; tests inject stubs to assert shape + count.
 *
 * Note: NEVER receives the event payload. The logger contract is
 * narrow on purpose — operator's log-shipping pipeline can't
 * accidentally surface PII via the audit failure path.
 */
export type AuditFailureLogger = (entry: AuditFailureLog) => void

export interface RecordToAllOptions {
  /** Providers to fan out to. Order doesn't matter (parallel). */
  providers: ReadonlyArray<AuditProvider>
  /**
   * Strict mode flag. `true` → caller blocks the write on any
   * provider failure (per design-audit.md "Strict mode opt-in").
   * `false` (default) → fail-open; operations always proceed.
   */
  strict?: boolean
  /**
   * Failure logger. Production wires `pino`. Tests inject `vi.fn()`.
   * When undefined, failures pass silently — useful for tests that
   * don't care about log output, but production should always wire
   * a real logger for diagnosability.
   */
  logFailure?: AuditFailureLogger
}

export interface RecordResult {
  /** Number of providers that successfully recorded. */
  succeeded: number
  /**
   * Number of providers that failed. Always 0 when no providers are
   * configured. Caller uses this in strict mode to abort the write.
   */
  failed: number
  /** Per-provider failure entries — for diagnostic surfaces. */
  failures: ReadonlyArray<AuditFailureLog>
}

/**
 * Fan-out an event to every configured provider in parallel.
 * Returns counts + per-failure entries; never throws (per Universal
 * Provider Requirement #5). Strict-mode behavior is the caller's
 * concern — the recorder does the dispatch + log; the caller branches
 * on `result.failed > 0` to abort the write.
 */
export async function recordToAll(event: AuditEvent, opts: RecordToAllOptions): Promise<RecordResult> {
  const { providers, logFailure } = opts
  if (providers.length === 0) return { succeeded: 0, failed: 0, failures: [] }

  const results = await Promise.allSettled(providers.map(p => p.record(event)))
  const failures: AuditFailureLog[] = []
  let succeeded = 0
  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    const provider = providers[i]
    if (result.status === 'fulfilled') {
      succeeded++
      continue
    }
    const entry: AuditFailureLog = {
      provider: provider.name,
      category: categorizeFailure(result.reason),
      reason: extractReason(result.reason),
    }
    failures.push(entry)
    logFailure?.(entry)
  }
  return { succeeded, failed: failures.length, failures }
}

/**
 * Categorize a thrown reason into the closed-enum category. Maps
 * `AuditTransportError.category` directly when present; falls back
 * to `'transport'` for unknown errors (most common — provider
 * SDKs rarely throw structured failure types).
 */
function categorizeFailure(reason: unknown): 'transport' | 'serialize' | 'quota' {
  if (reason instanceof Error) {
    // AuditTransportError carries category as a typed field.
    const maybeCategory = (reason as { category?: unknown }).category
    if (maybeCategory === 'transport' || maybeCategory === 'serialize' || maybeCategory === 'quota') {
      return maybeCategory
    }
  }
  return 'transport'
}

function extractReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message
  if (typeof reason === 'string') return reason
  return 'unknown failure'
}
