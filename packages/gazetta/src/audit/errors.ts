/**
 * Audit error taxonomy. Per `design-plugins.md`'s Universal Provider
 * Requirements, every provider surface gets its own error classes
 * so consumers can branch on the failure category.
 *
 * # Error taxonomy
 *
 *   - `AuditError`     — base class for all audit failures
 *   - `AuditConfigurationError` — invalid `admin.audit` config
 *     (unknown provider name, missing required field). Surfaces
 *     at admin boot; admin won't start.
 *   - `AuditTransportError` — provider couldn't reach its sink
 *     (network blip, 5xx from CloudWatch, etc.). Per Universal
 *     Provider Requirement #5: NEVER thrown — providers log and
 *     fall back to local-only recording. The class exists so
 *     transport-failure structured-log entries can carry a typed
 *     reason field.
 *
 * # Why no `AuditAuthorizationError`
 *
 * Audit READS gate on `read:audit-log` capability via the standard
 * capability middleware (`requireCapability` from auth/RBAC) — the
 * 403 surfaces as `AuthorizationError` from the existing taxonomy,
 * not a new audit-specific error class.
 *
 * # SOLID lenses
 *
 *   - SRP: error classes own only error identity; route handlers
 *     map to JSON via the existing error-response infrastructure.
 *   - LSP: subclasses extend `AuditError` so consumers can
 *     `instanceof AuditError` for catch-all handling.
 */

/** Base class for all audit-related errors. */
export class AuditError extends Error {
  override readonly name: string = 'AuditError'
  /** HTTP status the route should return when this error reaches one. */
  readonly httpStatus: number = 500
  constructor(message: string) {
    super(message)
  }
}

/**
 * Thrown at config-load time when `admin.audit` is malformed
 * (unknown provider, missing required field, invalid retention).
 * Admin won't start — operator sees the failure before any request
 * is served.
 */
export class AuditConfigurationError extends AuditError {
  override readonly name = 'AuditConfigurationError'
  override readonly httpStatus = 500
}

/**
 * Tagged transport failure. Per Universal Provider Requirement #5,
 * audit providers never throw on transport errors — they catch
 * internally and log via this category. The class exists so the
 * structured-log entries the recorder emits can carry a typed
 * reason field; route handlers never see this.
 */
export class AuditTransportError extends AuditError {
  override readonly name = 'AuditTransportError'
  override readonly httpStatus = 500
  /**
   * Categorical failure type for log-aggregator filtering.
   *
   *   - `transport` — network / HTTP failure on a provider with an
   *     external sink (CloudWatch outage, webhook timeout)
   *   - `serialize` — event couldn't be serialized to the provider's
   *     wire format
   *   - `quota`     — provider's storage tier rejected the write
   *     (CloudWatch log group full, file-cache disk full)
   */
  readonly category: 'transport' | 'serialize' | 'quota'
  constructor(message: string, category: 'transport' | 'serialize' | 'quota') {
    super(message)
    this.category = category
  }
}
