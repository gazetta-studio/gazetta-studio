/**
 * Principal middleware — wires the auth/RBAC layer (`packages/gazetta/src/auth/`)
 * into the Hono request context.
 *
 * # What this middleware does
 *
 * 1. On boot, constructs the configured `AuthIdentityProvider` from
 *    `admin.auth` in the loaded SiteManifest. Falls back to the
 *    `none`-mode provider when `admin.auth` is absent.
 * 2. On every request, calls `provider.extractPrincipal(req)` and
 *    attaches the result to `c.var.principal`.
 * 3. Anonymous requests (provider returns `null`) get a synthesized
 *    Principal with `id: 'unknown'` + `role: 'unknown'` + empty
 *    capabilities. The capability-check middleware (Cut 8) decides
 *    whether to allow these (none-mode or public routes) or 401.
 * 4. Provider throws (`AuthenticationError`) → 401 with the error
 *    message; doesn't leak details about the underlying failure.
 *
 * # Capability population
 *
 * For `forwarded-user` and `cloudflare-access` providers (which can
 * surface upstream group claims), this middleware would call
 * `resolveRole({ groups, mapping, customRoles })` to expand the
 * principal's capabilities. v1 wires the role-resolver in a
 * follow-up cut once one of the providers actually exposes group
 * claims through the AuthRequest shape — for now the providers
 * return `capabilities: []` and the operator's role mapping config
 * doesn't reach the resolver yet.
 *
 * # Why this is its own middleware (not folded into the existing one)
 *
 * The existing `authMiddleware` is a simple bearer-token guard for
 * `GAZETTA_TOKEN` — orthogonal to upstream-identity extraction.
 * They compose: bearer-token gates "is this request allowed to
 * reach the admin API at all"; principal middleware identifies
 * "who is the user behind this request." Most deployments use
 * one or the other (bearer-token for solo / dev; principal for
 * team CMS); some compose both (CI pipeline auth-token + upstream
 * Cloudflare Access for human users).
 *
 * # SOLID lenses
 *
 *   - SRP: extracts identity + attaches to context. Authorization
 *     (capability checks) is Cut 8's middleware.
 *   - DIP: depends on `AuthIdentityProvider` interface, not on
 *     specific provider classes.
 */
import { getConnInfo } from '@hono/node-server/conninfo'
import { createMiddleware } from 'hono/factory'
import type { Context } from 'hono'
import { problem } from '../problem.js'
import {
  AuthenticationError,
  type AuthIdentityProvider,
  type AuthRequest,
  type Principal,
  noneAuthProvider,
  UNKNOWN_ACTOR_ID,
} from '../../auth/index.js'
import { unmapIPv4 } from '../../auth/ip-match.js'
import { principalFromToken } from '../../auth/token-principal.js'
import type { ElevationStore } from '../../auth/elevation-store.js'
import type { SigningKeys } from '../../auth/tokens/keys.js'
import { TokenRejectedError, verifyToken } from '../../auth/tokens/token.js'

/**
 * Hono context augmentation — readers see `c.var.principal` typed
 * as `Principal` (always populated; never undefined after this
 * middleware runs).
 */
export type PrincipalEnv = {
  Variables: {
    principal: Principal
    /** Set for requests that came with a Gazetta token: the setup that verified it. */
    tokenAuth?: TokenAuth
  }
}

/**
 * The synthetic anonymous principal returned when no upstream
 * identity is present. Surfaced as `id: 'unknown'`, `role:
 * 'unknown'`, no capabilities — Cut 8's capability-check middleware
 * 401s on any required capability.
 */
const ANONYMOUS_PRINCIPAL: Principal = {
  id: UNKNOWN_ACTOR_ID,
  role: 'unknown',
  trustMode: 'none',
  capabilities: [],
}

/**
 * Whether the principal is the anonymous one: the request carried no
 * identity the trust mode could resolve.
 */
export function isAnonymous(principal: Principal): boolean {
  return principal.id === UNKNOWN_ACTOR_ID && principal.role === 'unknown'
}

/**
 * Adapt a Hono request into the `AuthRequest` shape the auth/
 * providers expect. Headers come from Hono's case-insensitive
 * lookup; we normalize to lowercase keys for provider consistency.
 */
function toAuthRequest(c: Context): AuthRequest {
  const headers = new Map<string, string>()
  // Hono exposes headers via c.req.header() (single value). The
  // raw request headers are accessible via c.req.raw.headers
  // which is a fetch-style Headers object.
  const raw = c.req.raw.headers
  raw.forEach((value, key) => {
    headers.set(key.toLowerCase(), value)
  })
  // Source IP — Hono doesn't expose this directly; honest extraction
  // is per-platform (per design-audit.md's trust-mode-driven IP
  // section). v1 reads from a CF-Connecting-IP / X-Forwarded-For
  // best-effort; provider-specific extraction lands when the audit
  // foundation's source-IP recording (Cut 4 of audit) ships.
  const sourceIp =
    raw.get('cf-connecting-ip') ?? raw.get('x-real-ip') ?? extractFirstXffEntry(raw.get('x-forwarded-for'))
  return {
    headers,
    sourceIp: sourceIp ?? undefined,
    peerAddress: connectionAddress(c),
    method: c.req.method,
    url: c.req.url,
  }
}

/**
 * The client's address for display and recording: the address headers
 * report, else the connection's. Never used for access decisions.
 */
export function requestSourceIp(c: Context): string | undefined {
  const { sourceIp, peerAddress } = toAuthRequest(c)
  return sourceIp ?? peerAddress
}

/**
 * The connection's remote address, from `@hono/node-server`'s socket.
 * Undefined when the request didn't come through the Node server
 * (`app.request()` without an env in tests).
 */
function connectionAddress(c: Context): string | undefined {
  let address: string | undefined
  try {
    address = getConnInfo(c).remote.address
  } catch {
    return undefined
  }
  return address ? unmapIPv4(address) : undefined
}

function extractFirstXffEntry(xff: string | null): string | null {
  if (!xff) return null
  const first = xff.split(',')[0]?.trim()
  return first || null
}

/**
 * Build the principal middleware. Pass the configured provider OR
 * omit to fall back to `none` mode. Production wiring resolves the
 * provider from `site.config.ts admin.auth` at boot.
 */
export interface TokenAuth {
  /** The signing keys, or null when CLI login is off. */
  keys: () => Promise<SigningKeys | null>
  /** Custom roles from `admin.auth.roles`, to expand a token's role. */
  customRoles?: Readonly<Record<string, ReadonlyArray<string>>>
  /** Elevation records (Q17); absent where nothing withheld is reachable. */
  elevations?: ElevationStore
  /** The environment of the target a request acts on, for the elevation scope. */
  environmentOf?: (c: Context) => string | undefined
}

/** The token in `Authorization: Bearer <token>`, if there is one. */
function bearerOf(c: Context): string | undefined {
  const m = /^Bearer\s+(\S+)$/i.exec(c.req.header('Authorization') ?? '')
  return m?.[1]
}

/** The header a Gazetta token travels in (design-agent-access.md Q15). */
export const GAZETTA_TOKEN_HEADER = 'Gazetta-Token'

export function principalMiddleware(provider: AuthIdentityProvider = noneAuthProvider, tokens?: TokenAuth) {
  return createMiddleware<PrincipalEnv>(async (c, next) => {
    // A request carrying a Gazetta token is that token's person or
    // nobody: a bad token never falls back to the login layer's identity.
    // Behind ALB, the token travels in `Authorization: Bearer`, the only
    // header ALB's JWT check reads (design-agent-access.md Q15).
    const token = c.req.header(GAZETTA_TOKEN_HEADER) ?? (provider.trustMode === 'aws-cognito' ? bearerOf(c) : undefined)
    if (token !== undefined) {
      const keys = tokens ? await tokens.keys() : null
      try {
        if (!keys) throw new TokenRejectedError('CLI login is off on this admin')
        c.set('principal', principalFromToken(await verifyToken(keys, token), tokens?.customRoles))
        c.set('tokenAuth', tokens)
      } catch (err) {
        if (!(err instanceof TokenRejectedError)) throw err
        c.header('WWW-Authenticate', 'Bearer realm="gazetta-admin"')
        return problem(c, 401, 'TOKEN_INVALID', err.message)
      }
      return next()
    }
    let principal: Principal | null
    try {
      principal = await provider.extractPrincipal(toAuthRequest(c))
    } catch (err) {
      if (err instanceof AuthenticationError) {
        // Surface as 401 with the error message. The provider's
        // message is operator-facing diagnostic detail (e.g.,
        // "JWT verification failed: signature invalid"); we surface
        // it in a structured body. For external-facing 401s the
        // middleware could mask the message, but this is admin-API
        // only — operators benefit from the diagnostic context.
        c.header('WWW-Authenticate', 'Bearer realm="gazetta-admin"')
        return problem(c, 401, 'UNAUTHENTICATED', err.message)
      }
      // Unexpected (non-AuthenticationError) — let Hono's default
      // error handler take over so the operator sees the stack.
      throw err
    }
    // Anonymous request — synthesize the unknown principal so
    // downstream middleware always has a Principal to read.
    c.set('principal', principal ?? ANONYMOUS_PRINCIPAL)
    await next()
  })
}
