/**
 * Retry a storage operation on transient socket-level errors. Scoped to
 * testcontainers' first-write race against freshly-provisioned MinIO
 * (and Azurite — same shape) where the port is up but internal metadata
 * hasn't propagated — a PUT lands, the socket is accepted, then dropped
 * mid-request as `socket hang up` / `ECONNRESET`. See #880.
 *
 * NOT for production use. Production S3/Azure services propagate before
 * responding to CreateBucket; this helper tolerates testcontainers'
 * weaker readiness contract. The S3/Azure provider implementations do
 * not retry (and shouldn't — a `socket hang up` against real S3 is a
 * real failure the caller needs to see).
 */

export interface RetryOptions {
  /** Max attempts including the first. Default 3. */
  maxAttempts?: number
  /** Base delay in ms; grows exponentially (base, 2×base, 4×base, ...). Default 100. */
  baseDelayMs?: number
}

export async function retryOnTransient<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3
  const baseDelayMs = opts.baseDelayMs ?? 100
  let lastErr: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!isTransientNetworkError(err) || attempt === maxAttempts) throw err
      await new Promise(r => setTimeout(r, baseDelayMs * 2 ** (attempt - 1)))
    }
  }
  // Unreachable — the loop either returns or throws — but TS wants
  // either a return or a throw after the loop body for completeness.
  throw lastErr
}

function isTransientNetworkError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  // AWS SDK wraps the underlying node error; the readable signal lives
  // in `.message` and sometimes in a `cause.code` chain. Check both.
  const e = err as { message?: unknown; code?: unknown; cause?: unknown }
  const msg = typeof e.message === 'string' ? e.message : ''
  const code = typeof e.code === 'string' ? e.code : ''
  if (
    msg.includes('socket hang up') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ECONNREFUSED') ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'EPIPE'
  ) {
    return true
  }
  if (e.cause) return isTransientNetworkError(e.cause)
  return false
}
