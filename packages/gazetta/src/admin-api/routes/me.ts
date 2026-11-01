/**
 * `GET /api/me` — the requesting principal, as resolved by the
 * principal middleware.
 *
 * No capability gate. A request the trust mode can't identify still
 * reaches handlers, carrying the shared anonymous principal; this
 * route answers 401 for it instead, so the client never treats
 * "nobody" as an owner of persisted drafts (it loads none). The admin
 * client reads this at boot — see design-offline.md, "Unsaved drafts
 * live in their own store".
 */
import { createRoute } from '@hono/zod-openapi'
import { isAnonymous, type PrincipalEnv } from '../middleware/principal.js'
import { apiApp, json, problems } from '../openapi.js'
import { MeResponseSchema, type MeResponse } from '../schemas/me.js'
import { problem } from '../problem.js'

const getMe = createRoute({
  method: 'get',
  path: '/me',
  summary: 'The signed-in principal',
  responses: {
    200: json(MeResponseSchema, 'Who the admin API thinks is asking'),
    ...problems({ 401: ['UNAUTHENTICATED'] }),
  },
})

export function meRoutes() {
  const app = apiApp<PrincipalEnv>()

  app.openapi(getMe, c => {
    const { id, role, trustMode } = c.var.principal
    if (isAnonymous(c.var.principal)) {
      c.header('WWW-Authenticate', 'Bearer realm="gazetta-admin"')
      return problem(c, 401, 'UNAUTHENTICATED', 'Not signed in')
    }
    const body: MeResponse = { id, role, trustMode }
    return c.json(body, 200)
  })

  return app
}
