/**
 * Capability-check middleware — gates a route on the principal's
 * having a specific capability.
 *
 * # Per-route opt-in
 *
 * Routes call `requireCapability('read:pages')` to attach a check
 * to a specific endpoint. The check runs after `principalMiddleware`
 * (so `c.var.principal` is populated). Anonymous principals (id
 * `'unknown'`) fail capability checks because their capability set
 * is empty — translates to 401 (not 403; per design-auth-rbac.md
 * the principal isn't authenticated yet).
 *
 * # Failure modes
 *
 *   - Principal is anonymous (no upstream auth) → 401 with
 *     WWW-Authenticate (matches the principal middleware's 401)
 *   - Principal is authenticated but lacks the capability → 403
 *     with structured body listing the missing capability and the
 *     principal's role
 *
 * # Composition
 *
 * Routes can wire multiple capability checks (e.g., a route that
 * needs both `read:pages` and `edit:pages` in different code paths
 * — the broader read check at the route level, narrower edit check
 * gating a specific operation). v1 ships single-capability gates;
 * multi-capability composition is left to the consumer.
 *
 * # SOLID lenses
 *
 *   - SRP: authorization gate only. Doesn't extract identity (Cut
 *     7's principalMiddleware does that), doesn't audit (Cut 5 of
 *     audit foundation does).
 *   - DIP: depends on `capabilityGrants` pure function, not on
 *     the principal middleware's internals.
 */
import { createMiddleware } from 'hono/factory'
import { capabilityGrants, UNKNOWN_ACTOR_ID } from '../../auth/index.js'
import type { PrincipalEnv } from './principal.js'

/**
 * Build a middleware that requires the specified capability.
 * Returns 401 for anonymous requests, 403 for authenticated
 * requests lacking the capability.
 */
export function requireCapability(capability: string) {
  return createMiddleware<PrincipalEnv>(async (c, next) => {
    const principal = c.get('principal')
    // Anonymous principal — no upstream identity. Translate to
    // 401 (not 403); the request hasn't authenticated yet.
    if (principal.id === UNKNOWN_ACTOR_ID && principal.role === 'unknown') {
      return c.json(
        { code: 'UNAUTHENTICATED' as const, error: `This endpoint requires capability "${capability}"` },
        401,
        { 'WWW-Authenticate': 'Bearer realm="gazetta-admin"' },
      )
    }
    // Authenticated principal — capability check.
    if (!capabilityGrants(principal.capabilities, capability)) {
      return c.json(
        {
          code: 'FORBIDDEN' as const,
          missing: [capability],
          role: principal.role,
          error: `Role "${principal.role}" does not have capability "${capability}"`,
        },
        403,
      )
    }
    await next()
  })
}
