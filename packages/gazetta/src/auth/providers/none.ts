/**
 * `none` trust mode — the default when `site.config.ts admin.auth`
 * is absent. Single-author behavior: every request resolves to the
 * canonical `unknown` principal with full admin capabilities.
 *
 * # Why this provider exists
 *
 * Establishes the seam (per `design-auth-rbac.md` Cut 2). Real
 * providers (`forwarded-user`, `cloudflare-access`, etc.) ship in
 * subsequent cuts; `none` is the LSP test bed proving the contract
 * works before any header parsing or signature verification lands.
 *
 * # The `unknown` principal
 *
 * The locked id `'unknown'` is reserved across the auth subsystem.
 * Pre-RBAC history revisions read with `actor: { id: 'unknown', ... }`
 * (computed on read, not persisted). The `none`-mode provider produces
 * the same shape so downstream consumers (audit, hooks, middleware)
 * branch uniformly: `principal.id === 'unknown'` means "no upstream
 * auth applied at this request."
 *
 * # Capabilities
 *
 * `none` mode grants full admin capabilities (`['*']`). Operators
 * running with `none` are running single-author / dev mode where the
 * single user has full access by definition. When `admin.auth.trust`
 * is anything else, this provider is never instantiated — the
 * dispatcher constructs the configured provider.
 *
 * # SOLID lenses
 *
 *   - SRP: single trust mode's mechanics; one method.
 *   - LSP: same `AuthIdentityProvider` shape as future providers.
 */
import type { Principal } from '../types.js'
import type { AuthIdentityProvider, AuthRequest } from '../provider.js'

/** Reserved subject identifier for unauthenticated / pre-RBAC contexts. */
export const UNKNOWN_ACTOR_ID = 'unknown'

/** Singleton instance — `none` mode has no per-instance state. */
export const noneAuthProvider: AuthIdentityProvider = {
  trustMode: 'none',
  async extractPrincipal(_req: AuthRequest): Promise<Principal> {
    // Always returns the canonical unknown principal with full
    // capabilities. Never returns null (would force middleware to
    // synthesize an anonymous principal anyway — cleaner to do it
    // here once).
    return {
      id: UNKNOWN_ACTOR_ID,
      role: 'admin',
      trustMode: 'none',
      capabilities: ['*'],
    }
  },
}
