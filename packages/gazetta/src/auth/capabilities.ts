/**
 * Capability vocabulary helpers — the closed set of built-in
 * capabilities and the matching logic for wildcard expansion.
 *
 * # Why these helpers live here
 *
 * Capabilities are strings, but the matching logic (does
 * `read:*` grant `read:pages`? does `*` grant everything?) is
 * load-bearing for every authorization check. Centralizing the
 * matching logic in pure functions means:
 *
 *   - Middleware uses one function, not ad-hoc string compares
 *   - Tests pin the wildcard semantics in one place
 *   - Plugin-supplied capabilities (when plugin foundation ships)
 *     extend via prefix conventions, not by changing matching code
 *
 * # SOLID lenses
 *
 *   - SRP: matching only; doesn't read configs or extract principals.
 *   - DIP: middleware depends on this helper, not on the BUILT_IN_ROLES
 *     constant.
 */
import { BUILT_IN_ROLES, type BuiltInCapability, KNOWN_CAPABILITIES, RESERVED_CAPABILITY_PREFIXES } from './types.js'

/**
 * Privacy-sensitive capabilities that prefix wildcards do NOT
 * grant. Per design-auth-rbac.md's "Audit-log read access is its
 * own capability — viewers don't see audit by default", and the
 * matching design-audit.md note that audit log is its own gate.
 *
 * These capabilities require either:
 *   - explicit grant (the exact capability string in the granted
 *     list), or
 *   - root wildcard `*` (admin role)
 *
 * Prefix wildcards (`read:*`) DO NOT grant them. Built-in editor
 * + viewer roles hold `read:*` — they get `read:pages`,
 * `read:fragments`, `read:assets` but NOT `read:audit-log`.
 * Operators wanting an "auditor" custom role declare
 * `['read:*', 'read:audit-log']` explicitly.
 *
 * Plugin authors adding privacy-sensitive capabilities extend this
 * set by exporting their own capability string in this set —
 * future plugin foundation will likely move this to a registry.
 * For v1 the set is closed to known built-ins.
 */
const WILDCARD_EXEMPT_CAPABILITIES: ReadonlySet<string> = new Set(['read:audit-log'])

/**
 * Test whether a principal's capability set grants the required
 * capability. Implements wildcard expansion:
 *
 *   - `*` (root wildcard) grants everything (including
 *     wildcard-exempt capabilities — admin role retains the
 *     escape hatch)
 *   - `<prefix>:*` grants every capability under that prefix
 *     EXCEPT capabilities in `WILDCARD_EXEMPT_CAPABILITIES`
 *   - exact match grants exactly that capability
 *
 * Plugin-supplied capabilities use scoped prefixes
 * (`@my-org/search:rebuild-index`) and follow the same rules:
 * `@my-org/search:*` grants `@my-org/search:rebuild-index`.
 */
export function capabilityGrants(granted: ReadonlyArray<string>, required: string): boolean {
  if (required.length === 0) return false
  const isExempt = WILDCARD_EXEMPT_CAPABILITIES.has(required)
  for (const cap of granted) {
    // Root wildcard always grants — admin retains the escape hatch
    // even for wildcard-exempt capabilities.
    if (cap === '*') return true
    if (cap === required) return true
    // Prefix wildcards skip wildcard-exempt capabilities.
    if (!isExempt && cap.endsWith(':*')) {
      const prefix = cap.slice(0, -1) // 'read:*' → 'read:'
      if (required.startsWith(prefix)) return true
    }
  }
  return false
}

/**
 * Expand a role name to its capability set. Built-in roles
 * (`admin`, `editor`, `viewer`) resolve from `BUILT_IN_ROLES`;
 * custom roles must be supplied via the `customRoles` map at
 * resolution time (per `design-auth-rbac.md`'s "hybrid built-in
 * + custom" model).
 *
 * Returns null when the role isn't recognized — caller decides
 * whether to fail-closed (deny access) or fail-open (assign default).
 */
export function expandRole(
  roleName: string,
  customRoles?: Readonly<Record<string, ReadonlyArray<string>>>,
): ReadonlyArray<string> | null {
  if (customRoles && roleName in customRoles) {
    return customRoles[roleName]
  }
  if (roleName in BUILT_IN_ROLES) {
    return BUILT_IN_ROLES[roleName] as ReadonlyArray<BuiltInCapability>
  }
  return null
}

/**
 * Validate that a capability string is one the runtime recognizes.
 *
 * Three classes:
 *
 *   - **Built-in** (in `KNOWN_CAPABILITIES`) → known. Includes
 *     exact-match literals (`read:pages`) AND wildcards (`read:*`,
 *     `*`).
 *   - **Plugin-scoped** (prefix starts with `@`, not in
 *     `RESERVED_CAPABILITY_PREFIXES`) → known by convention.
 *     Plugins extend the vocabulary via their own namespace; the
 *     plugin foundation (when shipped) is responsible for
 *     validating its own capabilities at registration time.
 *   - **Reserved-prefix but not built-in** (e.g., `review:foo`,
 *     `read:nonsense`) → unknown. These look like core
 *     capabilities but aren't in the closed set — almost always
 *     an operator typo or stale config.
 *
 * Consumed by the Zod refinement on `capabilitySchema` in
 * `config.ts` to reject unknown reserved-prefix capabilities at
 * site-config parse time. Strict-mode-vs-warn behavior (per
 * design-auth-rbac.md "Custom-role capability validation") is a
 * future polish; v1 hard-rejects.
 */
export function isKnownCapability(capability: string): boolean {
  if (KNOWN_CAPABILITIES.has(capability as BuiltInCapability)) return true
  // Plugin-scoped capabilities use namespaces outside the reserved
  // set; if the prefix isn't reserved, treat as plugin-extensible.
  const colonIdx = capability.indexOf(':')
  if (colonIdx <= 0) return false
  const prefix = capability.slice(0, colonIdx)
  return !(RESERVED_CAPABILITY_PREFIXES as readonly string[]).includes(prefix)
}
