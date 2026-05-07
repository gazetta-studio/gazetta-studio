/**
 * Background validation API + SSE channel (Cut 2).
 *
 * - `GET /api/validation/issues` — current accumulated issues from the
 *   per-instance scanner. Reads from the in-memory store; doesn't trigger
 *   a scan.
 * - `GET /__validation` — SSE channel that emits `validation-issues-updated`
 *   events when the scanner finishes a pass. Dev-only by convention; in
 *   production (`gazetta serve`) the route is mounted but emits no events
 *   because the scanner only triggers on saves and the admin store fetches
 *   `/api/validation/issues` after each save.
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
import type { ValidationScanner, ScanEvent } from '../../validation/scanner.js'

export interface ValidationRoutesOptions {
  /** Scanner instance shared across all routes. May be null when validation isn't enabled. */
  scanner: ValidationScanner | null
}

export function validationRoutes(opts: ValidationRoutesOptions) {
  const app = new Hono()

  /**
   * GET /api/validation/issues — current issues. Returns an empty list when
   * no scanner is configured (validation disabled or pre-scan boot).
   */
  app.get('/api/validation/issues', c => {
    if (!opts.scanner) return c.json({ issues: [], total: 0 })
    const issues = opts.scanner.allIssues()
    return c.json({ issues, total: issues.length })
  })

  /**
   * GET /__validation — SSE stream of `validation-issues-updated` events
   * when the scanner finishes a pass.
   *
   * The drawer subscribes once at admin boot. On every event, it re-fetches
   * `/api/validation/issues` to pick up the latest set. Two-step (event +
   * re-fetch) instead of pushing the full diff in the event payload because
   * the issue set is small (~tens to hundreds of items at envelope) and a
   * fresh GET is simpler than diff reconciliation client-side.
   *
   * When `scanner` is null, the route still mounts but never emits — keeps
   * the client's EventSource open so it doesn't reconnect-spam.
   */
  app.get('/__validation', async c => {
    return streamSSE(c, async stream => {
      const queue: ScanEvent[] = []
      let resolveWaiter: (() => void) | null = null

      const dispose = opts.scanner?.subscribe(event => {
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
        await stream.writeSSE({
          event: 'validation-issues-updated',
          data: JSON.stringify(event),
        })
      }
    })
  })

  return app
}
