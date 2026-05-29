/**
 * `tailscale` trust mode — Tailscale Funnel / serve fronting the
 * admin. Tailscale terminates the connection and adds identity
 * headers from the authenticated tailnet user.
 *
 * # Why no source-IP whitelist
 *
 * Per design-auth-rbac.md "Trust-mode-driven header extraction":
 * Tailscale serves direct (no proxy chain). The trust comes from
 * the operator running their admin on a Tailscale-protected
 * tailnet — anything not on the tailnet can't reach the listener.
 *
 * # Headers
 *
 *   - `Tailscale-User-Login` (required) — username@tailnet.ts.net
 *   - `Tailscale-User-Profile-Pic` (optional) — profile picture URL
 *   - `Tailscale-User-Name` (optional) — display name
 *   - `Tailscale-User-Groups` (optional) — operator-supplied,
 *     comma-separated group list (see role mapping below)
 *
 * The username is in the form `alice@example.ts.net`. We use the
 * full string as `id`; the email part (`alice`) is a per-tailnet
 * identifier — operators with multiple tailnets need the full form
 * to disambiguate.
 *
 * # Group source for role mapping
 *
 * Tailscale has no native group concept it forwards as a header, so
 * `roleMapping` for this trust mode reads groups from a custom
 * `Tailscale-User-Groups` header the operator populates (e.g. via a
 * `tailscale serve` config or a fronting proxy that maps tailnet
 * ACL tags to a comma-separated list). When no `roleMapping` is
 * configured the header is ignored and every authenticated tailnet
 * user gets `defaultRole`.
 *
 * # SOLID lenses
 *
 *   - SRP: header read; no verification needed (tailnet IS the trust).
 *   - LSP: same `AuthIdentityProvider` shape.
 */
import type { Principal, RoleMapping } from '../types.js'
import type { AuthIdentityProvider, AuthRequest } from '../provider.js'
import { expandRole } from '../capabilities.js'
import { resolveRole } from '../role-resolver.js'
import { AuthenticationError } from '../errors.js'

export interface TailscaleConfig {
  /**
   * Role assigned when no `roleMapping` is configured. When
   * `roleMapping` IS set, the resolved group → role mapping (and its
   * own `defaultRole`) takes over and this field is unused.
   */
  defaultRole?: string
  /**
   * Group → role mapping from `site.config.ts admin.auth`. Groups
   * come from the operator-supplied `Tailscale-User-Groups` header
   * (comma-separated) since Tailscale exposes no group claim itself.
   */
  roleMapping?: RoleMapping
  /**
   * Custom role declarations from `site.config.ts admin.auth.roles`,
   * flattened to `name → capabilities`. Consulted by the role
   * resolver when `roleMapping` points at a non-built-in role.
   */
  customRoles?: Readonly<Record<string, ReadonlyArray<string>>>
}

export function createTailscaleAuthProvider(config: TailscaleConfig = {}): AuthIdentityProvider {
  const defaultRole = config.defaultRole ?? 'editor'
  return {
    trustMode: 'tailscale',
    async extractPrincipal(req: AuthRequest): Promise<Principal | null> {
      const login = req.headers.get('tailscale-user-login')
      if (!login || login.length === 0) {
        // No tailscale identity — request bypassed Tailscale's
        // serve. Either the operator misconfigured, or a request
        // arrived through a different listener. Anonymous → 401.
        return null
      }

      // Tailscale-User-Login is shaped `user@tailnet.ts.net`.
      // We treat the whole string as id; operators wanting a
      // shorter display name can use the tailscale-user-name header
      // if present.
      let role: string
      let capabilities: ReadonlyArray<string>
      if (config.roleMapping) {
        const groups = (req.headers.get('tailscale-user-groups') ?? '')
          .split(',')
          .map(g => g.trim())
          .filter(Boolean)
        const resolved = resolveRole({
          groups,
          mapping: config.roleMapping,
          customRoles: config.customRoles,
        })
        if (!resolved) {
          throw new AuthenticationError(
            `tailscale principal "${login}" matched no role in roleMapping and no defaultRole is configured`,
          )
        }
        role = resolved.name
        capabilities = resolved.capabilities
      } else {
        role = defaultRole
        capabilities = expandRole(defaultRole) ?? []
      }

      return {
        id: login,
        // Tailscale's email-shaped login is functionally the user's
        // email for display purposes.
        email: login,
        role,
        trustMode: 'tailscale',
        capabilities,
      }
    },
  }
}
