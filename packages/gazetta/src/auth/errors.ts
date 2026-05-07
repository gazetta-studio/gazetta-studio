/**
 * Auth-specific error taxonomy. Distinct from validation errors;
 * downstream consumers (route handlers, audit recorder) catch these
 * to map to the right HTTP status and audit outcome.
 *
 * # Why a dedicated taxonomy
 *
 * Per `design-plugins.md`'s Universal Provider Requirements, every
 * provider surface has its own error taxonomy. Auth's errors split
 * along three axes:
 *
 *   - Configuration errors (invalid `site.config.ts admin.auth`
 *     block) — surface at boot, fail closed
 *   - Authentication errors (the upstream provider couldn't extract
 *     identity) — surface as 401
 *   - Authorization errors (principal lacks the required capability)
 *     — surface as 403
 *
 * # SOLID lenses
 *
 *   - SRP: error classes own only error identity and HTTP-status
 *     mapping. They don't carry rendering logic — route handlers
 *     map to JSON via `error-response.ts`.
 *   - LSP: every subclass extends `AuthError` so route handlers
 *     can branch on the base class then narrow by instanceof.
 */

/** Base class for all auth-related errors. */
export class AuthError extends Error {
  override readonly name: string = 'AuthError'
  /** HTTP status the route should return. Subclasses override. */
  readonly httpStatus: number = 500
  constructor(message: string) {
    super(message)
  }
}

/**
 * Thrown at config-load time when `admin.auth` is malformed (unknown
 * trust mode, role-mapping references unknown capabilities, etc.).
 * Admin won't start.
 */
export class AuthConfigurationError extends AuthError {
  override readonly name = 'AuthConfigurationError'
  override readonly httpStatus = 500
}

/**
 * Thrown when the upstream provider's expected header / claim is
 * missing, malformed, or fails signature verification. Surfaces as
 * 401 with `WWW-Authenticate` hint pointing back at the upstream.
 */
export class AuthenticationError extends AuthError {
  override readonly name = 'AuthenticationError'
  override readonly httpStatus = 401
}

/**
 * Thrown when an authenticated principal lacks the capability the
 * route requires. Surfaces as 403 with structured body listing
 * `missing` capabilities and the principal's `role`.
 */
export class AuthorizationError extends AuthError {
  override readonly name = 'AuthorizationError'
  override readonly httpStatus = 403
  /**
   * Capabilities the principal would need to authorize this request.
   * Surfaced in the 403 body so authenticated users see what they
   * can't do — per design-auth-rbac.md "Failure mode": existence-
   * leak risk doesn't justify 404-hide-existence semantics for
   * already-authenticated users.
   */
  readonly missing: ReadonlyArray<string>
  /** Principal's role at decision time — surfaced in the 403 body. */
  readonly role: string
  constructor(message: string, missing: ReadonlyArray<string>, role: string) {
    super(message)
    this.missing = missing
    this.role = role
  }
}
