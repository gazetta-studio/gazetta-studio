/**
 * `HookContext` builder — per-request factory that admin-api route
 * handlers call to construct the context passed to dispatch.
 *
 * The HookContext is built ONCE per request (not per-hook) and
 * shared across every dispatch in that request. This is the
 * "deterministic timestamp" invariant from design-hooks.md "Locked
 * invariants" — `now` is computed when the context is built so all
 * hooks in the request see the same wall clock.
 *
 * # Why a builder, not a middleware
 *
 * Earlier drafts considered a `hooksMiddleware` that attaches the
 * context to `c.var.hooks`. The reason that doesn't work as
 * cleanly: HookContext needs the SCOPE of each operation
 * (page name, fragment name, locale, etc.) which the middleware
 * can't know — only the route handler does. Route handlers
 * already have everything they need (principal from
 * `c.var.principal`, headers from `c.req`, source from the
 * resolver); a tiny builder function bundles them into a
 * HookContext per-call.
 *
 * # Read-only storage proxy
 *
 * The HookContext exposes `storage` as `ReadOnlyStorageProvider`.
 * v1 uses a Proxy that forwards read methods only; write methods
 * are absent from the type and would throw at the proxy layer if
 * called via type assertion. This is the "Proxy implementation"
 * design open question 2 from design-hooks.md — accepted with the
 * Proxy approach for less code duplication.
 *
 * # Logger fallback
 *
 * Until the logging foundation lands, the context's `log` field is
 * a no-op logger. design-hooks.md notes this: "v1 hooks dispatch
 * supplies a no-op logger or pino child as available."
 *
 * # SOLID lenses
 *
 *   - SRP: builder constructs the context; doesn't dispatch
 *     (Cut 2's concern), doesn't discover handlers (Cut 3's), and
 *     doesn't audit hook firings (Cut 7's).
 *   - DIP: builder takes a Principal + StorageProvider + ID
 *     generator + clock; doesn't reach into Hono internals.
 */
import type { Principal } from '../auth/types.js'
import type { StorageProvider } from '../types.js'
import type { ReadOnlyStorageProvider } from './storage.js'
import type { HookContext, HookLogger, ReadOnlySiteConfig } from './types.js'

const NOOP_LOGGER: HookLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

export interface BuildHookContextOptions {
  principal: Principal
  storage: StorageProvider
  /** Active target name when the operation is target-scoped. */
  target?: string
  /** Per-request correlation ID; matches audit + log ids. */
  requestId: string
  /** Request timestamp; deterministic for all hooks in this request. */
  now?: Date
  /** Logger; defaults to no-op until logging foundation lands. */
  log?: HookLogger
  /** Read-only site config. */
  site: ReadOnlySiteConfig
}

/**
 * Build a HookContext for one request. Construct once per request
 * and pass to every dispatch in that request — the `now` and
 * `requestId` fields are deterministic across the per-request
 * dispatches.
 */
export function buildHookContext(opts: BuildHookContextOptions): HookContext {
  return {
    principal: opts.principal,
    target: opts.target,
    requestId: opts.requestId,
    now: opts.now ?? new Date(),
    log: opts.log ?? NOOP_LOGGER,
    site: opts.site,
    storage: makeReadOnlyStorage(opts.storage),
  }
}

/**
 * Wrap a `StorageProvider` in a read-only Proxy. The returned
 * value satisfies `ReadOnlyStorageProvider`; the wrapped read
 * methods forward to the underlying provider; the write methods
 * are absent from the type AND would throw if invoked via type
 * assertion.
 *
 * Why Proxy instead of a copy of read methods: Proxy preserves
 * `this` for any inherited methods + future read methods (e.g.,
 * `stat()` if added later) flow through automatically.
 */
function makeReadOnlyStorage(storage: StorageProvider): ReadOnlyStorageProvider {
  const READ_METHODS = new Set(['readFile', 'readDir', 'exists', 'readBytes', 'readStream'])
  const handler: ProxyHandler<StorageProvider> = {
    get(target, prop, receiver) {
      if (typeof prop !== 'string') return Reflect.get(target, prop, receiver)
      if (READ_METHODS.has(prop)) {
        const method = Reflect.get(target, prop, receiver)
        if (typeof method === 'function') return method.bind(target)
        return method
      }
      // Write methods + anything else: throw to surface the
      // contract violation. Hooks should never reach for
      // writeFile/writeBytes/writeStream/mkdir/rm via ctx.storage.
      throw new TypeError(
        `Hook context's storage is read-only — "${prop}" is not available. Writes go through the operation that fired the hook.`,
      )
    },
  }
  return new Proxy(storage, handler) as unknown as ReadOnlyStorageProvider
}
