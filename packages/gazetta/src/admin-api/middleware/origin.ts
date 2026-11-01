/**
 * Runs each admin API request inside its origin (design-agent-access.md
 * Q22, Q47): the channel from the principal, the run id from the
 * `Gazetta-Run` header. Revisions and audit events read it; route
 * handlers never set it. A malformed run id answers a problem 400 before
 * anything is written.
 */
import { createMiddleware } from 'hono/factory'
import { isRunId, originOf, RUN_HEADER, runWithOrigin } from '../../request-origin.js'
import { problem } from '../problem.js'
import type { PrincipalEnv } from './principal.js'

export function originMiddleware() {
  return createMiddleware<PrincipalEnv>(async (c, next) => {
    const runId = c.req.header(RUN_HEADER)
    if (runId !== undefined && !isRunId(runId)) {
      return problem(
        c,
        400,
        'BAD_REQUEST',
        `${RUN_HEADER} must be 1 to 64 letters, digits, ".", "_" or "-", other than "." and ".."`,
      )
    }
    await runWithOrigin(originOf(c.var.principal, runId), () => next())
  })
}
