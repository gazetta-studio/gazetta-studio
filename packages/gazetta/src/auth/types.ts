/**
 * Auth + RBAC types — the load-bearing primitives every downstream
 * foundation (audit, hooks, review-workflow) consumes.
 *
 * # Why these types live here
 *
 * Gazetta does NOT do authentication itself. Operators put admin
 * behind upstream auth (Cloudflare Access, oauth2-proxy, Tailscale,
 * etc.) and Gazetta reads identity from configured request headers.
 * This module defines the shape of that identity AFTER the upstream
 * layer has authenticated — what audit records, what hooks see, what
 * the capability middleware checks.
 *
 * # Trust modes
 *
 * Each `TrustMode` corresponds to a documented upstream platform.
 * The auth provider for that mode knows how to extract identity from
 * that platform's request shape (signed JWT, custom header, etc.).
 *
 * # Single role per principal
 *
 * Per `design-auth-rbac.md` Q2 lock. Multi-role complexity (precedence
 * conflicts, role intersection) deferred until concrete operator
 * demand. Operators who need multi-role today compose custom roles
 * with the union of needed capabilities.
 *
 * # SOLID lenses
 *
 *   - SRP: this module owns the type vocabulary; doesn't read or
 *     write storage; pure data shapes.
 *   - DIP: downstream consumers (audit, hooks, middleware) depend on
 *     `Principal` interface, not on which trust mode produced it.
 *   - ISP: trust modes are a closed enum, not a capability interface
 *     each provider must implement methods for.
 */

/**
 * The closed set of trust modes Gazetta knows how to extract identity
 * from. Adding a new mode requires:
 *   1. New entry in this enum
 *   2. New `AuthIdentityProvider` implementation under `auth/providers/`
 *   3. Registration in the trust-mode dispatcher
 *
 * Plugin promotion (per design-auth-rbac.md Q1): 3+ operator requests
 * for an unlisted platform within 6 months → either add in-tree (if
 * mainstream) OR promote to plugin extension surface.
 */
export type TrustMode =
  /** Default. No upstream auth assumed. Single-author behavior. */
  | 'none'
  /** Generic reverse-proxy mode (Caddy, oauth2-proxy, Authelia). */
  | 'forwarded-user'
  /** Cloudflare Access — signed JWT in `Cf-Access-Jwt-Assertion`. */
  | 'cloudflare-access'
  /** Azure App Service Easy Auth — base64 `X-MS-CLIENT-PRINCIPAL`. */
  | 'azure-easy-auth'
  /** AWS ALB + Cognito — JWT in `x-amzn-oidc-data`. */
  | 'aws-cognito'
  /** Tailscale Funnel / serve — `Tailscale-User-Login` header. */
  | 'tailscale'

/**
 * Snapshot of the authenticated user as it reaches Gazetta handlers.
 * Per `design-auth-rbac.md`'s "Actor is a snapshot, not a live
 * reference" invariant: subsequent role changes don't rewrite
 * recorded events.
 */
export interface Principal {
  /**
   * Stable upstream subject identifier. OIDC `sub`, OAuth subject,
   * Cloudflare Access `identity_nonce`, etc. NOT email — email
   * rotates; sub is stable. `'unknown'` for `none` trust mode and
   * pre-RBAC revisions read post-migration.
   */
  id: string
  /**
   * Optional human-readable identifier. Surfaces in audit drawer +
   * activity feed. Only present when the auth provider exposes it;
   * pseudonymization (per `design-audit.md`) drops it.
   */
  email?: string
  /**
   * Resolved Gazetta role at decision time. Snapshot, not live —
   * recorded events preserve the role active when the action ran.
   */
  role: string
  /**
   * Trust mode that produced this principal. Audit records this so
   * forensic queries can scope by trust mode (e.g., "all events
   * where trust=tailscale").
   */
  trustMode: TrustMode
  /**
   * Effective capabilities — the role's capability set after alias
   * expansion. Computed once per request; downstream middleware
   * reads this directly without re-resolving the role.
   */
  capabilities: ReadonlyArray<string>
}

/**
 * Configured role definition — either built-in (alias of capability
 * set) or custom (operator-declared in `site.config.ts`'s
 * `admin.auth.roles` block).
 */
export interface Role {
  /** Role name. Used in `roleMapping` and audit. */
  name: string
  /**
   * Capabilities granted by this role. Wildcards allowed
   * (`'read:*'`, `'*'`). Capability validation runs at config-load
   * (per Q3 lock — unknown capabilities flagged).
   */
  capabilities: ReadonlyArray<string>
}

/**
 * Group-claim → role mapping. Configured per-site; consumed by the
 * resolver after the auth provider extracts the upstream group list.
 */
export interface RoleMapping {
  /**
   * Which JSON claim / header field on the upstream principal carries
   * the group list. Convention: `groups` for OIDC; varies per provider.
   */
  claim: string
  /** Map from upstream group name to Gazetta role name. */
  map: Readonly<Record<string, string>>
  /**
   * Fallback when no group matches. `null` means deny access (401);
   * a role name means assign that role.
   */
  defaultRole?: string | null
}

/**
 * Reserved capability prefixes — first segment of a capability name
 * (`read:pages` → `read`). Plugin-supplied capabilities use plugin-
 * scoped prefixes (e.g., `@my-org/search:rebuild-index`).
 */
export const RESERVED_CAPABILITY_PREFIXES = [
  'read',
  'edit',
  'delete',
  'publish',
  'configure',
  'review',
  'restore',
] as const

/**
 * Capability vocabulary — the closed set of built-in capabilities
 * that Gazetta routes gate on. Plugin-contributed capabilities
 * (when plugin foundation ships) extend via plugin-scoped prefixes
 * — they don't overlap this list.
 */
export type BuiltInCapability =
  // Read
  | 'read:pages'
  | 'read:fragments'
  | 'read:assets'
  | 'read:audit-log'
  // Edit
  | 'edit:pages'
  | 'edit:fragments'
  | 'edit:assets'
  | 'edit:locale-variants'
  // Delete
  | 'delete:pages'
  | 'delete:fragments'
  | 'delete:assets'
  // Publish — narrowed by environment per design-auth-rbac.md;
  // request/approve gate the per-target publish-approval workflow
  // (design-review-workflow.md "Capability additions").
  | 'publish:non-production'
  | 'publish:production'
  | 'publish:request'
  | 'publish:approve'
  // Review workflow — per-content review-state transitions
  // (design-review-workflow.md "Capability additions"). `editor`
  // built-in gains `review:submit`; `review:approve` and the
  // publish-approval pair are reserved for operator-defined
  // custom roles (e.g. `reviewer`, `publisher` archetypes B-E).
  | 'review:submit'
  | 'review:approve'
  // Configure
  | 'configure:site'
  | 'configure:targets'
  // History
  | 'restore:history'
  // Wildcards
  | 'read:*'
  | 'edit:*'
  | 'delete:*'
  | 'publish:*'
  | 'review:*'
  | '*'

/**
 * Built-in role aliases — predefined as capability sets. Custom
 * roles in `site.config.ts admin.auth.roles` declare capabilities
 * directly.
 *
 * Per design-auth-rbac.md's foundational lock, this map is the
 * closed set `{ admin, editor, viewer }`. `reviewer` / `publisher`
 * archetypes from `design-review-workflow.md` are CUSTOM roles
 * operators declare in `admin.auth.roles` — they don't appear
 * here. Adding them would break the lock (and the resolver's
 * `BUILT_IN_ROLES` regression guard at config-load).
 *
 * `editor` carries `review:submit` so the editor archetype can
 * push their work into the review workflow without an admin
 * role bump; `review:approve` lives on operator-defined
 * `reviewer` custom roles.
 */
export const BUILT_IN_ROLES: Readonly<Record<string, ReadonlyArray<BuiltInCapability>>> = {
  admin: ['*'],
  editor: ['read:*', 'edit:*', 'publish:non-production', 'review:submit'],
  viewer: ['read:*'],
}
