/**
 * Background validation API (Cut 2).
 *
 * - `GET /api/validation/issues` — current accumulated issues from the
 *   per-instance scanner. Reads from the in-memory store; doesn't trigger
 *   a scan.
 *
 * The peer SSE channel (`/__validation`) lives at the outer Hono app —
 * see `mountValidationSse()` below. This mirrors `/__reload`'s placement:
 * SSE channels sit at the outer app's root so dev-mode browsers reach them
 * without going through Vite's middleware (which would 404 anything not
 * matched by Vite's `proxy` config).
 *
 * Per `design-validation-implementation.md` Cut 2 + open question 5 (SSE
 * channel locked to its own path so cache invalidations + validation
 * events don't share a route).
 *
 * # SOLID lenses
 *
 * - SRP: route maps scanner state to HTTP. Doesn't run validators, doesn't
 *   trigger scans.
 * - DIP: depends on `ValidationScanner` interface; tests pass a fake.
 * - ISP: scanner exposes a narrow read surface (`allIssues` + `subscribe`);
 *   the route consumes only what it needs.
 */
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { ScanEvent, ValidationScanner } from '../../validation/scanner.js'
import { requireCapability } from '../middleware/capability.js'

export interface ValidationRoutesOptions {
  /** Scanner instance shared across all routes. May be null when validation isn't enabled. */
  scanner: ValidationScanner | null
}

export function validationRoutes(opts: ValidationRoutesOptions) {
  const app = new Hono()

  /**
   * GET /api/validation/issues — current issues. Returns an empty list when
   * no scanner is configured (validation disabled or pre-scan boot).
   *
   * Gated on `read:pages`: the issue list carries item paths + validator
   * messages, so it follows the same capability gate as every peer read
   * route (compare / fields / site / templates).
   */
  app.get('/api/validation/issues', requireCapability('read:pages'), c => {
    if (!opts.scanner) return c.json({ issues: [], total: 0 })
    const issues = opts.scanner.allIssues()
    return c.json({ issues, total: issues.length })
  })

  return app
}

/**
 * Mount `GET /__validation` SSE channel on the outer Hono app. The browser
 * EventSource opens this URL at the root (not under `/admin/`), matching
 * the pattern `/__reload` already follows. Production (`gazetta serve`)
 * pass `null` for `scanner` to mount a stub that never emits events —
 * keeps the client's EventSource open so it doesn't reconnect-spam.
 *
 * The drawer subscribes once at admin boot. On every event, it re-fetches
 * `/api/validation/issues` to pick up the latest set. Two-step (event +
 * re-fetch) instead of pushing the full diff in the event payload because
 * the issue set is small (~tens to hundreds of items at envelope) and a
 * fresh GET is simpler than diff reconciliation client-side.
 */
export function mountValidationSse(app: Hono, scanner: ValidationScanner | null): void {
  app.get('/__validation', async c => {
    return streamSSE(c, async stream => {
      const queue: ScanEvent[] = []
      let resolveWaiter: (() => void) | null = null

      const dispose = scanner?.subscribe(event => {
        queue.push(event)
        if (resolveWaiter) {
          const r = resolveWaiter
          resolveWaiter = null
          r()
        }
      })

      stream.onAbort(() => {
        dispose?.()
        if (resolveWaiter) {
          const r = resolveWaiter
          resolveWaiter = null
          r()
        }
      })

      // Open-frame: clients (EventSource) transition to OPEN on first byte.
      await stream.writeSSE({ data: '', event: 'ready' })

      while (!stream.aborted) {
        if (queue.length === 0) {
          await new Promise<void>(resolve => {
            resolveWaiter = resolve
          })
          continue
        }
        const event = queue.shift()!
        // Always emit the generic "issues updated" event so the
        // site-health drawer + tree dots stay current regardless
        // of the trigger.
        await stream.writeSSE({
          event: 'validation-issues-updated',
          data: JSON.stringify(event),
        })
        // Cut 6 — emit a distinct `template-changed` event in
        // addition when the rescan was triggered by a template
        // edit. The TemplateChangedBanner consumes this to surface
        // the developer-focused "did I break anything?" UI without
        // forcing every SSE listener to filter by cause.kind.
        if (event.cause?.kind === 'template') {
          // Surface the affected-item count alongside the name.
          // "Affected" = items where the post-rescan state has at
          // least one issue from `schema-conformance` (the
          // validator that's sensitive to template-shape changes).
          // Computed by the scanner state via the optional
          // `affectedCount` field — when undefined (older callers),
          // banner shows the name without a count.
          const affectedItemCount = event.cause.affectedItemCount
          await stream.writeSSE({
            event: 'template-changed',
            data: JSON.stringify({
              name: event.cause.name,
              affectedItemCount,
              durationMs: event.durationMs,
            }),
          })
        }
      }
    })
  })
}
