/**
 * Bridge between the hooks dispatch and the audit recorder.
 *
 * Per design-hooks.md "Audit events" + design-audit.md's locked
 * action/outcome enum extensions, every hook firing emits one
 * audit event:
 *
 *   action: 'hook-fired'
 *   outcome: 'success' | 'hook-cancelled' | 'timeout'
 *   scope: { kind: 'site' }     // hook firings aren't scoped to a
 *                                // specific page; the triggering
 *                                // operation has its own audit record
 *   metadata: { hookName, phase, source, priority, durationMs }
 *
 * # Why scope.kind: 'site'
 *
 * The triggering operation (save / publish / upload) records its
 * own audit event with the right scope. The hook-firing record
 * is observational — "this hook ran during a site operation."
 * Scope at the operation level would require duplicating scope
 * resolution into dispatch; site-level keeps the seam clean and
 * forensic queries can correlate via requestId.
 *
 * # SOLID lenses
 *
 *   - SRP: bridge owns translation from HookFiringEvent →
 *     AuditEvent. Doesn't fire hooks, doesn't record events.
 *   - DIP: takes an AuditContext (or any record-shaped sink);
 *     dispatch depends on the emitter callback shape.
 */
import type { AuditContext } from '../audit/index.js'
import type { HookFiringEmitter } from '../hooks/index.js'

/**
 * Build a HookFiringEmitter that forwards every firing to
 * `audit.record(...)`. Pass into HookContext.auditEmit.
 */
export function makeAuditFiringEmitter(audit: AuditContext): HookFiringEmitter {
  return async event => {
    await audit.record({
      action: 'hook-fired',
      outcome: event.outcome,
      scope: { kind: 'site' },
      metadata: {
        hookName: event.hookName,
        phase: event.phase,
        source: event.source,
        priority: event.priority,
        durationMs: event.durationMs,
      },
    })
  }
}
