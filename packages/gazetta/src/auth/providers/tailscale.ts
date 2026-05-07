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
 *
 * The username is in the form `alice@example.ts.net`. We use the
 * full string as `id`; the email part (`alice`) is a per-tailnet
 * identifier — operators with multiple tailnets need the full form
 * to disambiguate.
 *
 * # SOLID lenses
 *
 *   - SRP: header read; no verification needed (tailnet IS the trust).
 *   - LSP: same `AuthIdentityProvider` shape.
 */
import type { Principal } from '../types.js'
import type { AuthIdentityProvider, AuthRequest } from '../provider.js'

export interface TailscaleConfig {
  /** Optional default role until Cut 6's role-resolver wires up. */
  defaultRole?: string
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
      // shorter display name can map via roleMapping or use the
      // tailscale-user-name header if present.
      return {
        id: login,
        // Tailscale's email-shaped login is functionally the user's
        // email for display purposes.
        email: login,
        role: defaultRole,
        trustMode: 'tailscale',
        capabilities: [],
      }
    },
  }
}
