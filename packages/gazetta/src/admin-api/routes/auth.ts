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
 * - `DELETE /auth/grants/:id` revokes one of the caller's own grants.
 *
 * Every route answers 503 while CLI login is off (no signing key on a
 * hosted admin, Q25).
 */
import { createRoute } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { type CliLoginStore, normalizeLoginCode } from '../../auth/cli-login-store.js'
import type { SigningKeys } from '../../auth/tokens/keys.js'
import { issueToken } from '../../auth/tokens/token.js'
import type { AuditEnv } from '../middleware/audit.js'
import { isAnonymous, requestSourceIp } from '../middleware/principal.js'
import { API_PREFIX, apiApp, json, problems } from '../openapi.js'
import { problem } from '../problem.js'
import {
  GrantParamSchema,
  LoginCodeParamSchema,
  LoginDecisionResponseSchema,
  LoginDetailsResponseSchema,
  RedeemLoginRequestSchema,
  RedeemLoginResponseSchema,
  RenewTokenRequestSchema,
  StartLoginRequestSchema,
  StartLoginResponseSchema,
  TokenResponseSchema,
} from '../schemas/auth.js'

export interface AuthRoutesOptions {
  store: CliLoginStore
  /** The signing keys, or null while CLI login is off. */
  keys: () => Promise<SigningKeys | null>
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
        403: ['BROWSER_REQUIRED'],
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
    ...problems({ 400: ['BAD_REQUEST'], 401: ['GRANT_INVALID'], 503: ['CLI_LOGIN_UNAVAILABLE'] }),
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

/** The approve page's URL: the admin's base (where `/api/v1` is mounted) plus `/cli-login/<code>`. */
function approveUrl(c: Context, code: string): string {
  const url = new URL(c.req.url)
  const base = url.pathname.slice(0, url.pathname.indexOf(API_PREFIX))
  return new URL(`${base}/cli-login/${code}`, url.origin).toString()
}

export function authRoutes({ store, keys }: AuthRoutesOptions) {
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
    const { machine, ip, startedAt, expiresAt, state } = login
    return c.json({ code: login.code, machine, ...(ip ? { ip } : {}), startedAt, expiresAt, state }, 200)
  })

  for (const verb of ['approve', 'deny'] as const) {
    app.openapi(decision(verb), async c => {
      const action = verb === 'approve' ? 'login-approve' : 'login-deny'
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
      const code = codeOf(c.req.valid('param').code)
      if (!code) return problem(c, 404, 'NOT_FOUND', 'No such login')
      const { id, email, role, trustMode } = c.var.principal
      const result =
        verb === 'approve'
          ? await store.approve(code, { id, ...(email ? { email } : {}), role, trustMode })
          : await store.deny(code)
      if (result.status === 'not-found') return problem(c, 404, 'NOT_FOUND', 'No such login')
      if (result.status === 'expired') return problem(c, 410, 'LOGIN_EXPIRED', 'This login code has expired')
      if (result.status === 'decided') return problem(c, 409, 'CONFLICT', 'This login was already decided')
      await c.var.audit.record({
        action,
        outcome: 'success',
        scope: { kind: 'site' },
        metadata: { machine: result.login.machine, ...(result.login.ip ? { ip: result.login.ip } : {}) },
      })
      return c.json({ state: verb === 'approve' ? ('approved' as const) : ('denied' as const) }, 200)
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
    }
    const signingKeys = (await keys())!
    const { grant, grantSecret } = result
    const { token, expiresAt } = await issueToken(signingKeys, { ...grant.person, grantId: grant.grantId })
    return c.json({ status: 'approved' as const, grantId: grant.grantId, grantSecret, token, expiresAt }, 200)
  })

  app.openapi(renewToken, async c => {
    const grant = await store.grantFor(c.req.valid('json').grantSecret)
    if (!grant) return problem(c, 401, 'GRANT_INVALID', 'This grant is unknown or was revoked; log in again')
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
    await c.var.audit.record({
      action: 'grant-revoke',
      outcome: 'success',
      scope: { kind: 'site' },
      metadata: { grantId: id },
    })
    return c.body(null, 204)
  })

  return app
}
