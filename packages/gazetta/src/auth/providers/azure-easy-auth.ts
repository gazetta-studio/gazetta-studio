/**
 * `azure-easy-auth` trust mode — Azure App Service's built-in
 * authentication ("Easy Auth") fronting the admin. The platform
 * authenticates the user (via Azure AD, Microsoft Account, Google,
 * etc.) and populates the `X-MS-CLIENT-PRINCIPAL` header with a
 * base64-encoded JSON describing the principal.
 *
 * # Why no JWT verification
 *
 * Easy Auth runs in-process inside the App Service runtime; the
 * header it sets is never reachable from the public internet. The
 * App Service sandbox IS the trust boundary. (Cf the design's
 * "Header-spoofing protection per mode" — Easy Auth's protection
 * is the platform sandbox, not in-Gazetta verification.)
 *
 * Operators MUST run this trust mode behind a real Azure App Service
 * with Easy Auth enabled — running `gazetta serve` directly with
 * this trust mode has no protection because anyone can set the
 * header. The schema-time check could enforce this; we document it
 * + rely on operator awareness for v1.
 *
 * # Header shape
 *
 * Azure App Service's `X-MS-CLIENT-PRINCIPAL` is base64-encoded
 * JSON of the form:
 *
 *     {
 *       "auth_typ": "aad" | "google" | ...,
 *       "name_typ": "...",
 *       "role_typ": "...",
 *       "claims": [
 *         { "typ": "...", "val": "..." },
 *         ...
 *       ]
 *     }
 *
 * Common claim types:
 *   - `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier` — sub
 *   - `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress` — email
 *   - `name` — display name
 *   - `roles` — group / role list (one claim per role)
 *
 * Companion headers:
 *   - `X-MS-CLIENT-PRINCIPAL-ID` — id (sometimes)
 *   - `X-MS-CLIENT-PRINCIPAL-NAME` — username
 *
 * # SOLID lenses
 *
 *   - SRP: header decoding only. Trust verification is the platform's
 *     job.
 *   - LSP: same `AuthIdentityProvider` shape as the other providers.
 */
import type { Principal, RoleMapping } from '../types.js'
import type { AuthIdentityProvider, AuthRequest } from '../provider.js'
import { AuthenticationError } from '../errors.js'
import { expandRole } from '../capabilities.js'
import { resolveRole } from '../role-resolver.js'

export interface AzureEasyAuthConfig {
  /**
   * Role assigned when no `roleMapping` is configured. When
   * `roleMapping` IS set, the resolved group → role mapping (and its
   * own `defaultRole`) takes over and this field is unused.
   */
  defaultRole?: string
  /**
   * Group → role mapping from `site.config.ts admin.auth`. Azure
   * emits one claim per group/role under a `typ` named by the team's
   * Easy Auth config (commonly `roles`); when set, every claim whose
   * `typ` equals `roleMapping.claim` contributes its `val` to the
   * group list resolved against the map.
   */
  roleMapping?: RoleMapping
  /**
   * Custom role declarations from `site.config.ts admin.auth.roles`,
   * flattened to `name → capabilities`. Consulted by the role
   * resolver when `roleMapping` points at a non-built-in role.
   */
  customRoles?: Readonly<Record<string, ReadonlyArray<string>>>
}

interface AzureClaim {
  typ: string
  val: string
}

interface AzureClientPrincipal {
  auth_typ: string
  claims: AzureClaim[]
}

const NAMEID_CLAIM = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier'
const EMAIL_CLAIM = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'

export function createAzureEasyAuthProvider(config: AzureEasyAuthConfig = {}): AuthIdentityProvider {
  const defaultRole = config.defaultRole ?? 'editor'
  return {
    trustMode: 'azure-easy-auth',
    async extractPrincipal(req: AuthRequest): Promise<Principal | null> {
      const encoded = req.headers.get('x-ms-client-principal')
      if (!encoded || encoded.length === 0) {
        // No identity header — anonymous. Easy Auth is configured
        // to require auth; reaching Gazetta without the header
        // means the request bypassed the platform (only possible
        // if the operator misconfigured).
        return null
      }

      let parsed: AzureClientPrincipal
      try {
        const json = Buffer.from(encoded, 'base64').toString('utf-8')
        parsed = JSON.parse(json) as AzureClientPrincipal
      } catch (err) {
        throw new AuthenticationError(
          `X-MS-CLIENT-PRINCIPAL header is not valid base64-encoded JSON: ${(err as Error).message}`,
        )
      }

      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.claims)) {
        throw new AuthenticationError('X-MS-CLIENT-PRINCIPAL is malformed (missing claims array)')
      }

      // Prefer X-MS-CLIENT-PRINCIPAL-ID when present (stable id);
      // fall back to the nameidentifier claim.
      const idHeader = req.headers.get('x-ms-client-principal-id')
      const nameIdClaim = parsed.claims.find(c => c.typ === NAMEID_CLAIM)?.val
      const id = idHeader ?? nameIdClaim
      if (!id) {
        throw new AuthenticationError(
          'X-MS-CLIENT-PRINCIPAL has no nameidentifier claim and no X-MS-CLIENT-PRINCIPAL-ID',
        )
      }

      const email = parsed.claims.find(c => c.typ === EMAIL_CLAIM)?.val

      let role: string
      let capabilities: ReadonlyArray<string>
      if (config.roleMapping) {
        // Azure emits one claim per group, all under the same `typ`;
        // collect every matching claim's value.
        const claimName = config.roleMapping.claim
        const groups = parsed.claims.filter(c => c.typ === claimName).map(c => c.val)
        const resolved = resolveRole({
          groups,
          mapping: config.roleMapping,
          customRoles: config.customRoles,
        })
        if (!resolved) {
          throw new AuthenticationError(
            `azure-easy-auth principal "${id}" matched no role in roleMapping and no defaultRole is configured`,
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
        email,
        role,
        trustMode: 'azure-easy-auth',
        capabilities,
      }
    },
  }
}
