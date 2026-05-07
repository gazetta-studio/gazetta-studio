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
import type { Principal } from '../types.js'
import type { AuthIdentityProvider, AuthRequest } from '../provider.js'
import { AuthenticationError } from '../errors.js'

export interface AzureEasyAuthConfig {
  /** Optional default role until Cut 6's role-resolver wires up. */
  defaultRole?: string
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

      return {
        id,
        email,
        role: defaultRole,
        trustMode: 'azure-easy-auth',
        capabilities: [], // Cut 6 populates via role-resolver
      }
    },
  }
}
