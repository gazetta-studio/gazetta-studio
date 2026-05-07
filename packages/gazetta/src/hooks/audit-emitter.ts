/**
 * Hook firing audit emitter — the seam between the hooks
 * dispatcher and the audit recorder.
 *
 * Per design-hooks.md "Audit events" + design-audit.md's locked
 * `action: 'hook-fired'` + `outcome: 'hook-cancelled' | 'timeout'`
 * extensions:
 *
 *   - Every hook firing emits an audit event with hook name +
 *     priority + phase + durationMs.
 *   - `outcome` reflects the hook firing's result:
 *       'success'         — completed within timeout
 *       'hook-cancelled'  — `before*` threw (or non-cancellation
 *                            error wrapped as HookCancellation)
 *       'timeout'         — per-handler timeout fired before
 *                            resolve
 *   - One firing = one event; correlation across firings in the
 *     same operation is via shared `requestId` (audit + log).
 *
 * # Why a callback, not a direct audit dependency
 *
 * dispatch.ts must stay independent of audit-context wiring so
 * the same code path runs in tests (no audit) and in production
 * (full audit). The callback shape lets the caller decide
 * whether/how to record. When the callback is undefined, dispatch
 * is silent.
 *
 * # SOLID lenses
 *
 *   - SRP: this module owns the emitter contract; doesn't construct
 *     audit providers, doesn't run hooks.
 *   - DIP: dispatch depends on the `HookFiringEmitter` callback;
 *     callers (admin-api wiring) supply an implementation that
 *     forwards to `c.var.audit.record(...)`.
 */
import type { HookContext, HookPhase, HookRegistration } from './types.js'

/**
 * One audit-emittable hook firing event. Captured by the
 * dispatcher and forwarded to the caller-supplied emitter.
 */
export interface HookFiringEvent {
  /** Phase the hook fired in. */
  phase: HookPhase
  /** Hook name (from registration meta or file basename). */
  hookName: string
  /** Source identity ('site-local', plugin name, 'built-in'). */
  source: string
  /** Priority at registration time. */
  priority: number
  /**
   * Outcome of the firing. `'success'` for handlers that resolved
   * within the timeout window; `'hook-cancelled'` for `before*`
   * handlers that threw; `'timeout'` for handlers that exceeded
   * their per-handler timeout.
   */
  outcome: 'success' | 'hook-cancelled' | 'timeout'
  /** Wall-clock duration (ms) from invocation to resolve / throw. */
  durationMs: number
  /** Triggering request's HookContext (carries actor, requestId, etc.). */
  ctx: HookContext
}

/**
 * Caller-supplied audit emitter. Invoked synchronously per hook
 * firing; consumer typically forwards to `c.var.audit.record(...)`.
 *
 * The emitter MUST NOT throw — failures isolate to the dispatcher
 * via try/catch. Consumers wanting to surface emit failures use
 * their own logging.
 */
export type HookFiringEmitter = (event: HookFiringEvent) => void | Promise<void>

/** Helper for registrations — extracts the metadata the emitter needs. */
export function eventFromRegistration<P extends HookPhase>(
  reg: HookRegistration<P>,
  ctx: HookContext,
  outcome: HookFiringEvent['outcome'],
  durationMs: number,
): HookFiringEvent {
  return {
    phase: reg.phase,
    hookName: reg.name,
    source: reg.source,
    priority: reg.priority,
    outcome,
    durationMs,
    ctx,
  }
}
