/**
 * `CacheError` taxonomy per `design-cache.md` Gap 5.
 *
 * Two leaf classes today; more land as v2 providers ship and
 * surface their own failure modes (e.g., Redis transport errors,
 * Azure Service Bus reconnect failures).
 *
 * # SOLID lenses
 *
 *   - SRP: error classes only. No logging, no retry policy.
 *   - OCP: new failure classes extend `CacheError`; existing
 *     handlers continue to catch the base class.
 *   - LSP: every subclass IS a `CacheError`; `instanceof` checks
 *     work uniformly.
 */

/** Base class for all cache errors. */
export class CacheError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'CacheError'
  }
}

/**
 * Thrown at admin boot when cache config is invalid (missing env
 * var for a remote provider, malformed connection string, unknown
 * provider name). Admin won't start.
 */
export class CacheConfigurationError extends CacheError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'CacheConfigurationError'
  }
}

/**
 * Thrown when a stored value can't be deserialized. Rare; consumers
 * typically log + return null rather than propagate.
 */
export class CacheSchemaError extends CacheError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'CacheSchemaError'
  }
}
