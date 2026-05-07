/**
 * `AuditProvider` — the seam between Gazetta's recording sites
 * (save/publish/delete/restore handlers, capability middleware,
 * principal middleware) and the operator's chosen audit sink.
 *
 * # The contract
 *
 * Per `design-audit.md`'s "Surface-specific contract":
 *
 *   - `record(event)` — write an `AuditEvent` to the sink. MUST
 *     NOT throw on transport errors; falls back to local-only
 *     recording on failure (the dispatcher in Cut 3 catches +
 *     logs via `AuditTransportError`).
 *   - `query(filter)` — optional. Providers that own queryable
 *     storage implement this; external-sink providers (webhook,
 *     OTel) omit it.
 *   - `queryUrl()` — optional. Returns a deep-link to the
 *     operator's destination console (CloudWatch / Azure Monitor
 *     URLs). Providers that own queryable storage typically omit.
 *
 * # Plugin promotion path
 *
 * Per ADR-0009 + `design-plugins.md`: external audit providers
 * ship as npm packages exporting factory functions returning
 * `AuditProvider`. Operators import + invoke at the audit config
 * field (Pattern 3 — multi-provider fan-out via `auditChain([...])`
 * when shipped). No runtime register method.
 *
 * # SOLID lenses
 *
 *   - SRP: each provider owns one sink's mechanics; no cross-cutting
 *     concerns.
 *   - LSP: every provider returns events shaped by `AuditEvent`;
 *     consumers branch only on `outcome` / `action` for behavior.
 *   - DIP: recorder + drawer depend on this interface, never on
 *     concrete classes.
 *   - ISP: interface stays narrow — record + optional query + optional
 *     queryUrl. No capability-detection methods every provider must
 *     stub out.
 */
import type { AuditEvent, AuditQuery } from './types.js'

export interface AuditProvider {
  /**
   * Stable name. Used in failure log entries and in the audit
   * drawer's "View in {name}" deep-link button. Convention:
   * lowercase-kebab-case (`'history'`, `'cloudwatch'`,
   * `'http-webhook'`).
   */
  readonly name: string
  /**
   * Record an audit event. MUST NOT throw on transport errors;
   * fall back to local recording on failure. Audit failures never
   * block writes (fail-open default; strict mode opt-in via
   * `admin.audit.strict: true` — handled by the recorder dispatcher
   * in Cut 3).
   */
  record(event: AuditEvent): Promise<void>
  /**
   * Optional — providers that own queryable storage implement this.
   * External-sink providers that push events elsewhere (CloudWatch,
   * webhook, OTel) omit it; the audit drawer falls back to a deep
   * link from `queryUrl()` in those cases.
   */
  query?(filter: AuditQuery): Promise<AuditEvent[]>
  /**
   * Optional — providers that push to an external destination
   * return a deep-link to the operator's destination console.
   * Returning `null` means "configured but no link available."
   * Providers that own queryable storage typically omit this.
   */
  queryUrl?(): string | null
}
