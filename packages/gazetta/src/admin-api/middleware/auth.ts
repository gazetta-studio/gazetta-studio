import { createMiddleware } from 'hono/factory'
import { problem } from '../problem.js'
import { timingSafeCompare } from './timing-safe-compare.js'
import { refusedRequestFrom, type RefusalRecorder } from '../refusal-audit.js'

/** `refusals` records the write requests the guard refuses (design-audit.md). */
export function authMiddleware(refusals?: RefusalRecorder) {
  const token = process.env.GAZETTA_TOKEN
  if (!token) return createMiddleware(async (_c, next) => next())

  const expected = `Bearer ${token}`
  return createMiddleware(async (c, next) => {
    const auth = c.req.header('Authorization')
    if (!auth || !timingSafeCompare(auth, expected)) {
      await refusals?.signIn(refusedRequestFrom(c), 'token')
      return problem(c, 401, 'UNAUTHENTICATED', 'Unauthorized')
    }
    await next()
  })
}
