import { createMiddleware } from 'hono/factory'
import { problem } from '../problem.js'
import { timingSafeCompare } from './timing-safe-compare.js'

export function authMiddleware() {
  const token = process.env.GAZETTA_TOKEN
  if (!token) return createMiddleware(async (_c, next) => next())

  const expected = `Bearer ${token}`
  return createMiddleware(async (c, next) => {
    const auth = c.req.header('Authorization')
    if (!auth || !timingSafeCompare(auth, expected)) {
      return problem(c, 401, 'UNAUTHENTICATED', 'Unauthorized')
    }
    await next()
  })
}
