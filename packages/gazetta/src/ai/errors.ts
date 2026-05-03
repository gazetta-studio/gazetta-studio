/**
 * Typed errors for the AI domain — one class per failure mode, each
 * carrying an HTTP status so route handlers don't pattern-match on
 * messages.
 *
 * Pattern mirrors `assets/errors.ts`: subclass `AIError`, declare the
 * `code` and `httpStatus` on the class, override `toResponseBody()` if
 * extra structured fields are needed.
 *
 * Adding a new AI error is one new subclass + one new code in the
 * union. Routes pick up the new HTTP status via the `httpStatus`
 * property — no route-handler edits required (OCP).
 */

export type AIErrorCode = 'AI_ADAPTER_UNAVAILABLE' | 'AI_ADAPTER_FAILED' | 'AI_INVALID_RESPONSE'

export type AIErrorHttpStatus = 502 | 503

export interface AIErrorResponseBody {
  readonly code: AIErrorCode
  readonly message: string
}

/**
 * Base class. Subclasses set `code` and `httpStatus` as readonly
 * properties; the base provides the `toResponseBody()` machinery.
 */
export abstract class AIError extends Error {
  abstract readonly code: AIErrorCode
  abstract readonly httpStatus: AIErrorHttpStatus

  toResponseBody(): AIErrorResponseBody {
    return { code: this.code, message: this.message }
  }
}

/**
 * No adapter is configured for the target, OR the adapter is configured
 * but its credentials are missing, OR the adapter doesn't support the
 * requested MIME. UI hides AI affordances; route returns 503.
 *
 * Distinct from `AIAdapterFailedError` because this is a configuration
 * state, not a runtime failure — retrying won't help.
 */
export class AIAdapterUnavailableError extends AIError {
  readonly code = 'AI_ADAPTER_UNAVAILABLE'
  readonly httpStatus = 503
}

/**
 * Adapter was reached but the call failed — network error, auth
 * rejection, rate limit not handled by the SDK's own retry, malformed
 * response. Route returns 502 (we're acting as a gateway to the
 * upstream provider).
 *
 * The provider-specific cause is attached as `cause` (per the standard
 * Error.cause property) so logs can drill into the underlying failure
 * without leaking provider details into the API response.
 */
export class AIAdapterFailedError extends AIError {
  readonly code = 'AI_ADAPTER_FAILED'
  readonly httpStatus = 502
}

/**
 * Adapter received a response from the provider, but it didn't parse
 * into the expected shape (missing content field, unexpected null,
 * etc.). 502 — same gateway semantics as `AIAdapterFailedError`, but
 * the cause is parsing rather than transport.
 */
export class AIInvalidResponseError extends AIError {
  readonly code = 'AI_INVALID_RESPONSE'
  readonly httpStatus = 502
}
