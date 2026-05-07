/**
 * `HookRegistry` — priority-sorted, phase-keyed registration store.
 *
 * Per design-hooks.md "Composition (Q3 locked)":
 *
 *   - Lower priority runs earlier; default 100
 *   - Same priority resolves to registration order (stable sort)
 *   - Priority bands (convention only): 0-99 built-in, 100-999
 *     plugins, 1000+ site-local
 *
 * # Why a single registry per process, not per-phase
 *
 * Each phase has its own handler signature, but the registry's
 * job (sort by priority, look up by phase, seal post-init) is
 * uniform. One class with `Map<HookPhase, HookRegistration[]>`
 * internally is simpler than seven phase-specific registry
 * classes and makes "all phases see the same seal" trivially
 * true.
 *
 * # Sealing semantics
 *
 * `seal()` flips a flag; any subsequent `register(...)` call
 * throws `RegistrationAfterInitError`. Per ADR-0009 +
 * `design-plugins.md`, `buildHooksRegistry({ contributions })`
 * walks `admin.hooks` factory contributions at boot, registers
 * each entry, then calls `seal()`. Tests construct an unsealed
 * registry directly.
 *
 * # SOLID lenses
 *
 *   - SRP: registry owns (a) storage of registrations and (b)
 *     priority-sorted retrieval. Dispatch is a peer module that
 *     READS from the registry; doesn't mutate.
 *   - OCP: adding a new phase extends the type-level union; the
 *     registry's storage shape (`Map<HookPhase, ...>`) covers
 *     new entries without code changes.
 *   - DIP: dispatcher depends on `HookRegistry`'s public surface;
 *     storage layout is the implementation detail.
 */
import { RegistrationAfterInitError } from './errors.js'
import type { HookHandler, HookOptions, HookPhase, HookRegistration } from './types.js'

const DEFAULT_PRIORITY = 100
const DEFAULT_TIMEOUT_MS = 5000

/**
 * In-process registry for hook handlers. v1 scope: one instance
 * per admin process, constructed at boot, sealed after plugin
 * init resolves. Tests construct their own.
 */
export class HookRegistry {
  /**
   * Per-phase registration arrays. Insertion order = original
   * registration order; sort happens lazily on `getByPhase()` calls
   * so concurrent registrations don't pay the sort cost N times.
   */
  private readonly storage: Map<HookPhase, HookRegistration[]> = new Map()
  /** Stable monotonic counter for tie-breaking equal-priority entries. */
  private nextSequence = 0
  /** Once true, `register()` throws RegistrationAfterInitError. */
  private sealed = false

  /**
   * Register a handler for a phase.
   *
   * Throws `RegistrationAfterInitError` after `seal()` was called.
   *
   * `source` identifies who owns the handler (`'site-local'`,
   * plugin name, `'built-in'`). Surfaces in audit metadata + error
   * messages.
   */
  register<P extends HookPhase>(
    phase: P,
    handler: HookHandler<P>,
    options: HookOptions = {},
    source: string = 'site-local',
  ): void {
    if (this.sealed) {
      throw new RegistrationAfterInitError({ source, phase })
    }
    const registration: HookRegistration<P> = {
      phase,
      handler,
      priority: options.priority ?? DEFAULT_PRIORITY,
      name: options.name ?? source,
      timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
      sequence: this.nextSequence++,
      source,
    }
    const list = this.storage.get(phase) ?? []
    list.push(registration as HookRegistration)
    this.storage.set(phase, list)
  }

  /**
   * Retrieve every registration for a phase in priority order
   * (lower priority first). Stable: same-priority entries
   * preserve registration order.
   *
   * Returns a fresh array; callers can mutate without affecting
   * registry state.
   */
  getByPhase<P extends HookPhase>(phase: P): ReadonlyArray<HookRegistration<P>> {
    const list = this.storage.get(phase) ?? []
    // Sort a copy so concurrent registrations during iteration
    // don't reorder the in-place array. Stable sort: tie-break
    // by sequence preserves registration order for same-priority
    // entries.
    //
    // Cast through `unknown`: each phase-keyed Map slot only
    // contains registrations matching its key (enforced at
    // `register()`), but TS conditional types don't propagate
    // through Map's value variance. The runtime invariant holds.
    const sorted = [...list].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority
      return a.sequence - b.sequence
    })
    return sorted as unknown as ReadonlyArray<HookRegistration<P>>
  }

  /**
   * Total registration count. Used by diagnostics; tests pin via
   * this rather than reaching into private state.
   */
  size(phase?: HookPhase): number {
    if (phase === undefined) {
      let total = 0
      for (const list of this.storage.values()) total += list.length
      return total
    }
    return this.storage.get(phase)?.length ?? 0
  }

  /**
   * Seal the registry — subsequent registrations throw. Idempotent
   * (calling twice is a no-op; doesn't unseal).
   */
  seal(): void {
    this.sealed = true
  }

  /**
   * True after `seal()` has been called. Used by tests + plugin
   * loader diagnostics.
   */
  isSealed(): boolean {
    return this.sealed
  }
}
