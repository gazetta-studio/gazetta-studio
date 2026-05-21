/**
 * `cloudflare-access` trust mode — Cloudflare Zero Trust / Access
 * fronting the admin. The platform issues a signed JWT in the
 * `Cf-Access-Jwt-Assertion` header (or cookie); Gazetta verifies
 * the signature against Cloudflare's published JWKS and reads the
 * subject + email from the verified payload.
 *
 * # Why JWT verification, not header trust
 *
 * Cloudflare Access's JWT carries a real signature. Anyone behind
 * the Worker boundary can claim a header value, but only Cloudflare's
 * private key can produce a valid token. Verifying the signature is
 * the security contract — without it, this trust mode is no safer
 * than `forwarded-user` without a whitelist.
 *
 * # JWKS endpoint shape
 *
 * Cloudflare publishes per-team-domain JWKS at:
 *
 *     https://{teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs
 *
 * Operators set `teamDomain` in `site.config.ts admin.auth`; the
 * provider builds the URL and uses `jose`'s `createRemoteJWKSet`
 * for verification + automatic key rotation.
 *
 * # Failure modes
 *
 *   - JWT missing / expired / signature invalid → `AuthenticationError`
 *     (middleware → 401)
 *   - JWKS endpoint unreachable → `AuthenticationError` (fail-CLOSED
 *     here, NOT fail-open like Universal Provider Requirement #5
 *     suggests for transport errors — auth is the security boundary;
 *     a JWKS outage that fails open would let unsigned tokens
 *     through)
 *   - `aud` claim mismatch (when configured) → `AuthenticationError`
 *
 * # SOLID lenses
 *
 *   - SRP: JWT verification only. Source-IP extraction is not this
 *     provider's concern (Cloudflare's signed assertion IS the trust;
 *     the source IP would be Cloudflare's edge anyway).
 *   - DIP: jose's `createRemoteJWKSet` is the verifier dependency;
 *     test injects a different verifier via the optional
 *     `jwksFactory` constructor option for unit tests.
 */
import { jwtVerify, createRemoteJWKSet, type JWTPayload, type JWTVerifyGetKey } from 'jose'
import type { Principal, RoleMapping } from '../types.js'
import type { AuthIdentityProvider, AuthRequest } from '../provider.js'
import { AuthenticationError, AuthConfigurationError } from '../errors.js'
import { expandRole } from '../capabilities.js'
import { resolveRole } from '../role-resolver.js'

export interface CloudflareAccessConfig {
  /**
   * Cloudflare Zero Trust team domain (the part before
   * `.cloudflareaccess.com`). Required. Example: `'acme'` for
   * `https://acme.cloudflareaccess.com`.
   */
  teamDomain: string
  /**
   * Optional `aud` claim verification. Cloudflare Access tokens
   * carry an `aud` claim identifying the application; production
   * deployments SHOULD set this to prevent token replay across
   * Access-protected apps in the same team domain.
   */
  audience?: string
  /**
   * Role assigned when no `roleMapping` is configured. When
   * `roleMapping` IS set, the resolved group → role mapping (and its
   * own `defaultRole`) takes over and this field is unused.
   */
  defaultRole?: string
  /**
   * Group-claim → role mapping from `site.config.ts admin.auth`.
   * When set, the verified JWT's group list (read from the claim
   * named by `roleMapping.claim`) is resolved to a Gazetta role
   * instead of falling back to `defaultRole`.
   */
  roleMapping?: RoleMapping
  /**
   * Custom role declarations from `site.config.ts admin.auth.roles`,
   * flattened to `name → capabilities`. Consulted by the role
   * resolver when `roleMapping` points at a non-built-in role.
   */
  customRoles?: Readonly<Record<string, ReadonlyArray<string>>>
  /**
   * Internal: factory for the JWKS verifier. Tests inject a stub;
   * production calls `createRemoteJWKSet`.
   */
  jwksFactory?: (jwksUrl: URL) => JWTVerifyGetKey
}

/**
 * Cloudflare Access JWT claims. The verified payload always carries
 * `sub` and `iss`; `email` is included for human-friendly identity;
 * `identity_nonce` is Cloudflare's stable session identifier (we
 * prefer `sub` per the design's "stable upstream subject" invariant
 * but expose `identity_nonce` if `sub` is missing).
 */
interface CloudflareAccessClaims extends JWTPayload {
  email?: string
  identity_nonce?: string
  /** Cloudflare's group claim — populated when team policies use groups. */
  groups?: string[]
}

export function createCloudflareAccessAuthProvider(config: CloudflareAccessConfig): AuthIdentityProvider {
  if (!config.teamDomain || config.teamDomain.length === 0) {
    throw new AuthConfigurationError(
      'cloudflare-access trust mode requires teamDomain (your Cloudflare Zero Trust team domain, e.g. "acme")',
    )
  }
  // Validate the teamDomain shape — Cloudflare team domains are
  // lowercase alphanumeric + hyphens; reject obvious typos.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(config.teamDomain)) {
    throw new AuthConfigurationError(
      `Invalid teamDomain "${config.teamDomain}": must be lowercase alphanumeric + hyphens (the part before .cloudflareaccess.com)`,
    )
  }

  const jwksUrl = new URL(`https://${config.teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`)
  const expectedIssuer = `https://${config.teamDomain}.cloudflareaccess.com`
  const jwks = (config.jwksFactory ?? createRemoteJWKSet)(jwksUrl)
  const defaultRole = config.defaultRole ?? 'editor'

  return {
    trustMode: 'cloudflare-access',
    async extractPrincipal(req: AuthRequest): Promise<Principal | null> {
      // Cloudflare Access can deliver the assertion in either a
      // header or cookie. We accept both; header takes precedence
      // because it's the documented integration path.
      const token = req.headers.get('cf-access-jwt-assertion') ?? extractFromCookie(req.headers.get('cookie'))
      if (!token) {
        // No Cloudflare-Access token at all — anonymous. Middleware
        // turns this into 401.
        return null
      }

      let payload: CloudflareAccessClaims
      try {
        const result = await jwtVerify<CloudflareAccessClaims>(token, jwks, {
          issuer: expectedIssuer,
          audience: config.audience,
        })
        payload = result.payload
      } catch (err) {
        // jose throws JOSEError subclasses for signature / expiry /
        // claim mismatches. We don't differentiate — every failure
        // surfaces as AuthenticationError → 401 per Universal
        // Provider Requirement (auth fails closed on token failure).
        throw new AuthenticationError(`Cloudflare Access JWT verification failed: ${(err as Error).message}`)
      }

      const id = payload.sub ?? payload.identity_nonce
      if (!id) {
        throw new AuthenticationError('Cloudflare Access JWT has no sub or identity_nonce claim')
      }

      let role: string
      let capabilities: ReadonlyArray<string>
      if (config.roleMapping) {
        // Read the group list from the operator-configured claim
        // name — NOT a hardcoded `groups` field. Cloudflare emits
        // group claims under whatever name the team's Access policy
        // declares; reading the wrong key silently drops every
        // mapping and falls back to defaultRole.
        const groups = extractStringArray(payload[config.roleMapping.claim])
        const resolved = resolveRole({
          groups,
          mapping: config.roleMapping,
          customRoles: config.customRoles,
        })
        if (!resolved) {
          // Valid identity, but no group matched and no defaultRole
          // is configured — deny access per design-auth-rbac.md's
          // "defaultRole: null means deny".
          throw new AuthenticationError(
            `Cloudflare Access principal "${id}" matched no role in roleMapping and no defaultRole is configured`,
          )
        }
        role = resolved.name
        capabilities = resolved.capabilities
      } else {
        role = defaultRole
        capabilities = expandRole(defaultRole) ?? []
      }

      return {
        id,
        email: payload.email,
        role,
        trustMode: 'cloudflare-access',
        capabilities,
      }
    },
  }
}

/**
 * Coerce an arbitrary JWT claim value into a clean `string[]`. The
 * group claim is operator-named and operator-populated, so its shape
 * isn't guaranteed — a missing claim, a scalar, or a mixed array all
 * degrade to "no groups" rather than throwing.
 */
function extractStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/**
 * Cloudflare Access also delivers the JWT via the
 * `CF_Authorization` cookie. Extract it from the Cookie header
 * if present.
 */
function extractFromCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null
  const cookies = cookieHeader.split(';')
  for (const cookie of cookies) {
    const trimmed = cookie.trim()
    if (trimmed.startsWith('CF_Authorization=')) {
      return trimmed.slice('CF_Authorization='.length)
    }
  }
  return null
}
