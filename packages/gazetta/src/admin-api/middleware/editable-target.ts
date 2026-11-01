/**
 * Refuses content writes to a target that isn't editable. Write routes
 * resolve `?target=` to any configured target, so each content-write route
 * checks editability here: content is saved to an editable target and
 * reaches read-only targets through publish. The admin UI already hides
 * saving on read-only targets; this is the server's check.
 *
 * Publish, fetch and history restore move content into targets by design
 * and don't use it.
 */
import { createMiddleware } from 'hono/factory'
import { problem } from '../problem.js'
import type { SourceContextResolver } from '../source-context.js'

export function requireEditableTarget(resolve: SourceContextResolver) {
  return createMiddleware(async (c, next) => {
    const source = await resolve(c.req.query('target'))
    if (source.editable === false) {
      return problem(
        c,
        403,
        'TARGET_NOT_EDITABLE',
        `Target "${source.targetName}" isn't editable. Save to an editable target and publish from there.`,
      )
    }
    await next()
  })
}
