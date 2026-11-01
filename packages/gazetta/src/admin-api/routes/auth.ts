/**
 * CLI login (design-agent-access.md Q12, Q16, Q19, Q21, Q26):
 *
 * - `POST /auth/logins` starts a login: a code, the approve page's URL, a
 *   poll secret, 10 minutes.
 * - `GET /auth/logins/:code`, `POST .../approve`, `POST .../deny` are the
 *   approve page's. Only a person's browser may use them, never a Gazetta
 *   token (Q19).
 * - `POST /auth/logins/:code/redeem` is the client's poll: pending, or,
 *   once approved, a grant secret and a token, once per code.
 * - `POST /auth/tokens` renews a token from a grant secret.
 * - `DELETE /auth/grants/:id` revokes one of the caller's own grants, and
 *   its elevations.
 * - `POST /auth/elevations` (with a token) starts an elevation (Q12, Q17):
 *   a code the person approves on the same page, for one scope, lasting
 *   `elevationMinutes` from approval. Its poll answers the elevation's id
 *   and end; `DELETE /auth/elevations/:id` ends it early.
 *
 * Every route answers 503 while CLI login is off (no signing key on a
 * hosted admin, Q25).
 */
import { createRoute } from '@hono/zod-openapi'
import type { Context } from 'hono'
import {
  type CliLoginStore,
  grantExpiresAt,
  normalizeLoginCode,
  type PendingLogin,
} from '../../auth/cli-login-store.js'
import type { ElevationStore } from '../../auth/elevation-store.js'
import { withheldCapabilitiesOf } from '../../auth/token-cap.js'
import type { SigningKeys } from '../../auth/tokens/keys.js'
import { issueToken } from '../../auth/tokens/token.js'
import type { AuditEnv } from '../middleware/audit.js'
import { isAnonymous, requestSourceIp } from '../middleware/principal.js'
import { API_PREFIX, apiApp, json, problems } from '../openapi.js'
import { problem } from '../problem.js'
import {
  ElevationParamSchema,
  GrantParamSchema,
  LoginCodeParamSchema,
  LoginDecisionResponseSchema,
  LoginDetailsResponseSchema,
  RedeemLoginRequestSchema,
  RedeemLoginResponseSchema,
  RenewTokenRequestSchema,
  StartLoginRequestSchema,
  StartElevationRequestSchema,
  StartLoginResponseSchema,
  TokenResponseSchema,
} from '../schemas/auth.js'

export interface AuthRoutesOptions {
  store: CliLoginStore
  /** The signing keys, or null while CLI login is off. */
  keys: () => Promise<SigningKeys | null>
  elevations: ElevationStore
  /** How long an approved elevation lasts (`admin.auth.elevationMinutes`). */
  elevationMinutes: number
}

const jsonBody = <S>(schema: S) => ({ required: true, content: { 'application/json': { schema } } })

const startLogin = createRoute({
  method: 'post',
  path: '/auth/logins',
  summary: 'Start a CLI login',
  request: { body: jsonBody(StartLoginRequestSchema) },
  responses: {
    201: json(StartLoginResponseSchema, 'The login, waiting for approval'),
    ...problems({ 400: ['BAD_REQUEST'], 503: ['CLI_LOGIN_UNAVAILABLE'] }),
  },
})

const getLogin = createRoute({
  method: 'get',
  path: '/auth/logins/:code',
  summary: 'A pending login, for the approve page',
  request: { params: LoginCodeParamSchema },
  responses: {
    200: json(LoginDetailsResponseSchema, 'The login'),
    ...problems({
      401: ['UNAUTHENTICATED'],
      403: ['BROWSER_REQUIRED'],
      404: ['NOT_FOUND'],
      503: ['CLI_LOGIN_UNAVAILABLE'],
    }),
  },
})

const decision = (verb: 'approve' | 'deny') =>
  createRoute({
    method: 'post',
    path: `/auth/logins/:code/${verb}`,
    summary: verb === 'approve' ? 'Approve a CLI login' : 'Deny a CLI login',
    request: { params: LoginCodeParamSchema },
    responses: {
      200: json(LoginDecisionResponseSchema, 'Decided'),
      ...problems({
        401: ['UNAUTHENTICATED'],
        403: ['BROWSER_REQUIRED', 'FORBIDDEN'],
        404: ['NOT_FOUND'],
        409: ['CONFLICT'],
        410: ['LOGIN_EXPIRED'],
        503: ['CLI_LOGIN_UNAVAILABLE'],
      }),
    },
  })

const redeemLogin = createRoute({
  method: 'post',
  path: '/auth/logins/:code/redeem',
  summary: 'Collect an approved login: a grant and a token, once',
  request: { params: LoginCodeParamSchema, body: jsonBody(RedeemLoginRequestSchema) },
  responses: {
    200: json(RedeemLoginResponseSchema, 'Pending, or the grant and a token'),
    ...problems({
      400: ['BAD_REQUEST'],
      403: ['LOGIN_DENIED'],
      404: ['NOT_FOUND'],
      409: ['LOGIN_REDEEMED'],
      410: ['LOGIN_EXPIRED'],
      503: ['CLI_LOGIN_UNAVAILABLE'],
    }),
  },
})

const renewToken = createRoute({
  method: 'post',
  path: '/auth/tokens',
  summary: 'A fresh token from a grant',
  request: { body: jsonBody(RenewTokenRequestSchema) },
  responses: {
    200: json(TokenResponseSchema, 'A token for 15 minutes'),
    ...problems({ 400: ['BAD_REQUEST'], 401: ['GRANT_INVALID', 'GRANT_EXPIRED'], 503: ['CLI_LOGIN_UNAVAILABLE'] }),
  },
})

const revokeGrant = createRoute({
  method: 'delete',
  path: '/auth/grants/:id',
  summary: 'Revoke one of your own grants',
  request: { params: GrantParamSchema },
  responses: {
    204: { description: 'Revoked' },
    ...problems({ 401: ['UNAUTHENTICATED'], 404: ['NOT_FOUND'], 503: ['CLI_LOGIN_UNAVAILABLE'] }),
  },
})

const startElevation = createRoute({
  method: 'post',
  path: '/auth/elevations',
  summary: 'Ask to publish, delete or restore for a short time (with a token)',
  request: { body: jsonBody(StartElevationRequestSchema) },
  responses: {
    201: json(StartLoginResponseSchema, 'The elevation, waiting for approval'),
    ...problems({
      400: ['BAD_REQUEST'],
      401: ['TOKEN_REQUIRED', 'GRANT_INVALID', 'GRANT_EXPIRED'],
      503: ['CLI_LOGIN_UNAVAILABLE'],
    }),
  },
})

const endElevation = createRoute({
  method: 'delete',
  path: '/auth/elevations/:id',
  summary: 'End an elevation now',
  request: { params: ElevationParamSchema },
  responses: {
    204: { description: 'Ended' },
    ...problems({ 401: ['UNAUTHENTICATED'], 404: ['NOT_FOUND'], 503: ['CLI_LOGIN_UNAVAILABLE'] }),
  },
})

/** The approve page's URL: the admin's base (where `/api/v1` is mounted) plus `/cli-login/<code>`. */
function approveUrl(c: Context, code: string): string {
  const url = new URL(c.req.url)
  const base = url.pathname.slice(0, url.pathname.indexOf(API_PREFIX))
  return new URL(`${base}/cli-login/${code}`, url.origin).toString()
}

export function authRoutes({ store, keys, elevations, elevationMinutes }: AuthRoutesOptions) {
  const app = apiApp<AuditEnv>()

  // CLI login is off until there's a signing key.
  app.use('/auth/*', async (c, next) => {
    if (!(await keys())) {
      return problem(c, 503, 'CLI_LOGIN_UNAVAILABLE', 'CLI login is off: set GAZETTA_SIGNING_KEY on this admin')
    }
    await next()
  })

  /**
   * The person's browser, or a problem: the approve page never accepts a
   * Gazetta token (Q19), and needs someone the login layer identified.
   */
  const browserOnly = (c: Context<AuditEnv>) => {
    const principal = c.var.principal
    if (principal.channel === 'token') {
      return problem(c, 403, 'BROWSER_REQUIRED', 'Approve logins in your browser, not with a Gazetta token')
    }
    if (isAnonymous(principal)) {
      c.header('WWW-Authenticate', 'Bearer realm="gazetta-admin"')
      return problem(c, 401, 'UNAUTHENTICATED', 'Sign in to approve a login')
    }
    return null
  }

  const codeOf = (raw: string) => normalizeLoginCode(raw)

  app.openapi(startLogin, async c => {
    const { machine } = c.req.valid('json')
    const login = await store.start({ machine, ip: requestSourceIp(c) })
    return c.json({ ...login, approveUrl: approveUrl(c, login.code) }, 201)
  })

  app.openapi(getLogin, async c => {
    const refused = browserOnly(c)
    if (refused) return refused
    const code = codeOf(c.req.valid('param').code)
    const login = code ? await store.get(code) : null
    if (!login) return problem(c, 404, 'NOT_FOUND', 'No such login')
    const { machine, ip, startedAt, expiresAt, state, scope } = login
    // An elevation ended early has no record left: report no window then.
    const live = login.elevationId ? await elevations.get(login.elevationId) : null
    const elevationId = live?.elevationId
    const endsAt = live?.endsAt
    return c.json(
      {
        kind: login.kind ?? 'login',
        ...(scope ? { scope } : {}),
        ...(elevationId ? { elevationId, endsAt } : {}),
        code: login.code,
        machine,
        ...(ip ? { ip } : {}),
        startedAt,
        expiresAt,
        state,
      },
      200,
    )
  })

  /**
   * An elevation's extra checks before approving (Q12, Q17): the browser
   * person must be the grant's person and hold, now, a capability the
   * elevation would lift. Returns the elevation to record, or a problem.
   */
  const approveElevation = async (c: Context<AuditEnv>, login: PendingLogin) => {
    const grant = login.grantId ? await store.grantById(login.grantId) : null
    if (!grant || grantExpiresAt(grant) <= Date.now()) {
      return problem(c, 409, 'CONFLICT', 'The sign-in this elevation was for has been revoked or has expired')
    }
    const principal = c.var.principal
    if (grant.person.id !== principal.id) {
      return problem(c, 403, 'FORBIDDEN', 'This elevation was started by someone else')
    }
    const capabilities = withheldCapabilitiesOf(principal.capabilities)
    if (capabilities.length === 0) {
      return problem(c, 403, 'FORBIDDEN', `Role "${principal.role}" can't publish, delete or restore`)
    }
    return elevations.create({
      grantId: grant.grantId,
      personId: grant.person.id,
      scope: login.scope ?? 'non-production',
      capabilities,
      minutes: elevationMinutes,
      // An elevation ends with its grant (#1693).
      notAfter: grantExpiresAt(grant),
    })
  }

  for (const verb of ['approve', 'deny'] as const) {
    app.openapi(decision(verb), async c => {
      const code = codeOf(c.req.valid('param').code)
      const login = code ? await store.get(code) : null
      const kind = login?.kind ?? 'login'
      const action =
        kind === 'elevation'
          ? verb === 'approve'
            ? 'elevation-approve'
            : 'elevation-deny'
          : verb === 'approve'
            ? 'login-approve'
            : 'login-deny'
      const refused = browserOnly(c)
      if (refused) {
        await c.var.audit.record({
          action,
          outcome: refused.status === 401 ? 'unauthenticated' : 'forbidden',
          scope: { kind: 'site' },
          metadata: { reason: c.var.principal.channel === 'token' ? 'gazetta-token' : 'not-signed-in' },
        })
        return refused
      }
      if (!code || !login) return problem(c, 404, 'NOT_FOUND', 'No such login')
      if (Date.parse(login.expiresAt) <= Date.now()) {
        return problem(c, 410, 'LOGIN_EXPIRED', 'This code has expired')
      }
      if (login.state !== 'pending') return problem(c, 409, 'CONFLICT', 'This code was already decided')

      let elevation: Awaited<ReturnType<ElevationStore['create']>> | undefined
      if (verb === 'approve' && kind === 'elevation') {
        const approved = await approveElevation(c, login)
        if (approved instanceof Response) {
          await c.var.audit.record({
            action,
            outcome: 'forbidden',
            scope: { kind: 'site' },
            metadata: { reason: 'not-allowed', machine: login.machine },
          })
          return approved
        }
        elevation = approved
      }
      const { id, email, role, trustMode } = c.var.principal
      const result =
        verb === 'approve'
          ? await store.approve(
              code,
              { id, ...(email ? { email } : {}), role, trustMode },
              elevation && { elevationId: elevation.elevationId, endsAt: elevation.endsAt },
            )
          : await store.deny(code)
      if (result.status !== 'ok') {
        // Lost a race with another decision: the elevation never took effect.
        if (elevation) await elevations.end(elevation.elevationId)
        if (result.status === 'not-found') return problem(c, 404, 'NOT_FOUND', 'No such login')
        if (result.status === 'expired') return problem(c, 410, 'LOGIN_EXPIRED', 'This code has expired')
        return problem(c, 409, 'CONFLICT', 'This code was already decided')
      }
      await c.var.audit.record({
        action,
        outcome: 'success',
        scope: { kind: 'site' },
        metadata: {
          machine: result.login.machine,
          ...(result.login.ip ? { ip: result.login.ip } : {}),
          ...(login.scope ? { elevationScope: login.scope } : {}),
          ...(elevation ? { elevationId: elevation.elevationId, endsAt: elevation.endsAt } : {}),
        },
      })
      return c.json(
        {
          state: verb === 'approve' ? ('approved' as const) : ('denied' as const),
          ...(elevation ? { elevationId: elevation.elevationId, endsAt: elevation.endsAt } : {}),
        },
        200,
      )
    })
  }

  app.openapi(redeemLogin, async c => {
    const code = codeOf(c.req.valid('param').code)
    const result = code ? await store.redeem(code, c.req.valid('json').pollSecret) : { status: 'not-found' as const }
    switch (result.status) {
      case 'pending':
        return c.json({ status: 'pending' as const }, 200)
      case 'denied':
        return problem(c, 403, 'LOGIN_DENIED', 'The login was denied')
      case 'expired':
        return problem(c, 410, 'LOGIN_EXPIRED', 'This login code has expired')
      case 'redeemed':
        return problem(c, 409, 'LOGIN_REDEEMED', 'This login code was already used')
      case 'not-found':
        return problem(c, 404, 'NOT_FOUND', 'No such login')
      case 'elevated':
        return c.json({ status: 'elevated' as const, elevationId: result.elevationId, endsAt: result.endsAt }, 200)
    }
    const signingKeys = (await keys())!
    const { grant, grantSecret } = result
    const { token, expiresAt } = await issueToken(signingKeys, { ...grant.person, grantId: grant.grantId })
    return c.json({ status: 'approved' as const, grantId: grant.grantId, grantSecret, token, expiresAt }, 200)
  })

  app.openapi(renewToken, async c => {
    const found = await store.grantFor(c.req.valid('json').grantSecret)
    if (found.status === 'invalid') {
      return problem(c, 401, 'GRANT_INVALID', 'This grant is unknown or was revoked; sign in again')
    }
    if (found.status === 'expired') {
      // A grant's elevations end with it (they were capped at its expiry);
      // this removes their records too.
      const grantId = c.req.valid('json').grantSecret.split('.')[0]
      await elevations.endAll(grantId)
      return problem(c, 401, 'GRANT_EXPIRED', 'This sign-in is more than 30 days old; sign in again')
    }
    const { grant } = found
    const { token, expiresAt } = await issueToken((await keys())!, { ...grant.person, grantId: grant.grantId })
    return c.json({ token, expiresAt }, 200)
  })

  app.openapi(revokeGrant, async c => {
    if (isAnonymous(c.var.principal)) {
      c.header('WWW-Authenticate', 'Bearer realm="gazetta-admin"')
      return problem(c, 401, 'UNAUTHENTICATED', 'Sign in to revoke a grant')
    }
    const { id } = c.req.valid('param')
    if ((await store.revoke(id, c.var.principal.id)) === 'not-found') {
      return problem(c, 404, 'NOT_FOUND', 'No such grant')
    }
    await elevations.endAll(id)
    await c.var.audit.record({
      action: 'grant-revoke',
      outcome: 'success',
      scope: { kind: 'site' },
      metadata: { grantId: id },
    })
    return c.body(null, 204)
  })

  app.openapi(startElevation, async c => {
    const principal = c.var.principal
    if (principal.channel !== 'token' || !principal.grantId) {
      return problem(c, 401, 'TOKEN_REQUIRED', 'Elevations are for Gazetta tokens; the browser has its full role')
    }
    const grant = await store.grantById(principal.grantId)
    if (!grant) return problem(c, 401, 'GRANT_INVALID', 'This grant was revoked; sign in again')
    if (grantExpiresAt(grant) <= Date.now()) {
      return problem(c, 401, 'GRANT_EXPIRED', 'This sign-in is more than 30 days old; sign in again')
    }
    const { scope } = c.req.valid('json')
    const started = await store.startElevation({
      grantId: grant.grantId,
      machine: grant.machine,
      ip: requestSourceIp(c),
      scope,
    })
    return c.json({ ...started, approveUrl: approveUrl(c, started.code) }, 201)
  })

  app.openapi(endElevation, async c => {
    const principal = c.var.principal
    if (isAnonymous(principal)) {
      c.header('WWW-Authenticate', 'Bearer realm="gazetta-admin"')
      return problem(c, 401, 'UNAUTHENTICATED', 'Sign in to end an elevation')
    }
    const elevation = await elevations.get(c.req.valid('param').id)
    // The token holder (its grant) or the person in the browser; anyone
    // else's elevation answers as if it didn't exist.
    const owner =
      elevation &&
      (principal.channel === 'token' ? principal.grantId === elevation.grantId : principal.id === elevation.personId)
    if (!elevation || !owner) return problem(c, 404, 'NOT_FOUND', 'No such elevation')
    await elevations.end(elevation.elevationId)
    await c.var.audit.record({
      action: 'elevation-end',
      outcome: 'success',
      scope: { kind: 'site' },
      metadata: { elevationId: elevation.elevationId, by: principal.channel === 'token' ? 'token' : 'browser' },
    })
    return c.body(null, 204)
  })

  return app
}
