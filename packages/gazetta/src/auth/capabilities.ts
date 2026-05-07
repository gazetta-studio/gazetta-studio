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
import { BUILT_IN_ROLES, type BuiltInCapability } from './types.js'

/**
 * Test whether a principal's capability set grants the required
 * capability. Implements wildcard expansion:
 *
 *   - `*` (root wildcard) grants everything
 *   - `<prefix>:*` grants every capability under that prefix
 *   - exact match grants exactly that capability
 *
 * Plugin-supplied capabilities use scoped prefixes
 * (`@my-org/search:rebuild-index`) and follow the same rules:
 * `@my-org/search:*` grants `@my-org/search:rebuild-index`.
 */
export function capabilityGrants(granted: ReadonlyArray<string>, required: string): boolean {
  if (required.length === 0) return false
  for (const cap of granted) {
    if (cap === '*') return true
    if (cap === required) return true
    if (cap.endsWith(':*')) {
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
