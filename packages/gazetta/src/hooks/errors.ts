/**
 * Hook error taxonomy.
 *
 * Per design-hooks.md, three distinct error classes carry different
 * dispatcher semantics:
 *
 *   - `HookCancellation`: a `before*` hook threw to cancel the
 *     operation. Operation aborts; audit records
 *     `outcome: 'hook-cancelled'`. The original error (if not a
 *     `HookCancellation`) is wrapped so call sites can distinguish
 *     "hook explicitly cancelled" from "hook crashed."
 *
 *   - `HookTimeout`: a hook's per-handler timeout fired before the
 *     handler resolved. For `before*` hooks this cancels the
 *     operation (same handling as `HookCancellation`); for `after*`
 *     hooks it's logged + counted but doesn't propagate.
 *
 *   - `RegistrationAfterInitError`: thrown when code tries to
 *     register a hook after the boot-time registration phase has
 *     finished. `buildHooksRegistry({ contributions })` registers
 *     all factory contributions then calls `seal()`. Any subsequent
 *     `register(...)` surfaces this error — a deferred Promise that
 *     registers from inside a hook handler, for example, leaks past
 *     the registration window.
 *
 * # SOLID lenses
 *
 *   - SRP: each error class names one failure mode; consumers
 *     branch on `instanceof` to discriminate.
 *   - LSP: each subclass `extends HookError` so a `catch (err: HookError)`
 *     handler covers every hook-layer failure.
 *   - DIP: callers depend on the abstract `HookError` for catch-all
 *     handling; specific subclasses for fine-grained recovery.
 */

/** Base class for all hook-layer errors. */
export class HookError extends Error {
  override readonly name: string = 'HookError'
}

/**
 * A `before*` hook threw to cancel the operation, OR a hook handler
 * threw a non-cancellation error that the dispatcher wraps for
 * uniform handling.
 *
 * The originating handler's name is captured for audit metadata.
 * The original error (if any) is exposed via `cause` so operators
 * can investigate handler crashes vs. explicit cancellations.
 */
export class HookCancellation extends HookError {
  override readonly name = 'HookCancellation'
  /** The hook that cancelled — either `meta.name` or the file basename. */
  readonly hookName: string
  /** The phase the hook was firing in. */
  readonly phase: string

  constructor(opts: { hookName: string; phase: string; message?: string; cause?: unknown }) {
    super(opts.message ?? `Hook "${opts.hookName}" cancelled the ${opts.phase} operation`, {
      cause: opts.cause,
    })
    this.hookName = opts.hookName
    this.phase = opts.phase
  }
}

/**
 * A hook's per-handler timeout fired. The handler may still be
 * resolving (the dispatcher races the handler against a setTimeout-
 * backed promise) — but the operation can't wait for it.
 */
export class HookTimeout extends HookError {
  override readonly name = 'HookTimeout'
  readonly hookName: string
  readonly phase: string
  readonly timeoutMs: number

  constructor(opts: { hookName: string; phase: string; timeoutMs: number }) {
    super(`Hook "${opts.hookName}" timed out after ${opts.timeoutMs}ms in ${opts.phase}`)
    this.hookName = opts.hookName
    this.phase = opts.phase
    this.timeoutMs = opts.timeoutMs
  }
}

/**
 * Thrown when `register(...)` is called on a sealed `HookRegistry`
 * (post-boot).
 *
 * Registration window per ADR-0009 + `design-plugins.md`:
 * `buildHooksRegistry({ contributions })` walks `admin.hooks`
 * factory contributions at boot, registers each entry, then calls
 * `seal()`. Any subsequent `register(...)` surfaces this error —
 * for instance a deferred Promise inside a factory that resolves
 * after the registration window closed, or a hook handler that
 * tries to register additional hooks at runtime.
 */
export class RegistrationAfterInitError extends HookError {
  override readonly name = 'RegistrationAfterInitError'
  /** Source identity (plugin name / `'site-local'`) attempting late registration. */
  readonly source: string
  /** Phase the late registration targeted. */
  readonly phase: string

  constructor(opts: { source: string; phase: string }) {
    super(
      `Hook registration window has closed. Source "${opts.source}" attempted to register a "${opts.phase}" handler after admin init completed. Move the registration into the plugin's init() function.`,
    )
    this.source = opts.source
    this.phase = opts.phase
  }
}
