/**
 * Role resolution — translates upstream group claims into a Gazetta
 * role + the role's capability set.
 *
 * # The resolution chain
 *
 *   1. Pull the group list from the principal's claims (header /
 *      JWT payload — provider-specific, surfaces as a `string[]`)
 *   2. Walk the operator's `roleMapping.map` from `site.config.ts`;
 *      first matching upstream group → Gazetta role name
 *   3. Fall back to `roleMapping.defaultRole` if no group matches;
 *      `null` means deny access
 *   4. Expand the role name to its capability set via
 *      `expandRole(name, customRoles)`
 *
 * # Why "first match wins" not "highest precedence"
 *
 * Per `design-auth-rbac.md` Q3 lock: priority is array order in the
 * map config. Operators control precedence by ordering their map.
 * Predictable, deterministic, no implicit precedence.
 *
 * # SOLID lenses
 *
 *   - SRP: pure function over (groups, mapping, customRoles);
 *     doesn't read `site.config.ts` directly, doesn't depend on
 *     specific provider shape.
 *   - DIP: providers pass the resolved groups; this module doesn't
 *     know about JWT claims or HTTP headers.
 */
import { expandRole } from './capabilities.js'
import { BUILT_IN_ROLES, type RoleMapping } from './types.js'

export interface ResolveRoleArgs {
  /** Group names from the upstream auth provider's claim. */
  groups: ReadonlyArray<string>
  /** Operator's roleMapping config (claim + map + defaultRole). */
  mapping?: RoleMapping
  /** Custom role declarations from `site.config.ts admin.auth.roles`. */
  customRoles?: Readonly<Record<string, ReadonlyArray<string>>>
}

export interface ResolvedRole {
  /** The chosen Gazetta role name. */
  name: string
  /** The role's capability set after alias expansion. */
  capabilities: ReadonlyArray<string>
}

/**
 * Resolve the principal's role + capability set.
 *
 * Returns `null` when:
 *   - No group matches AND `defaultRole` is null (deny access)
 *   - Resolved role name doesn't expand (unknown role)
 *
 * Caller (middleware) translates `null` into 403 / 401 per request
 * shape.
 */
export function resolveRole(args: ResolveRoleArgs): ResolvedRole | null {
  const { groups, mapping, customRoles } = args
  let roleName: string | null | undefined

  if (mapping) {
    // First-match-wins per array order. Iteration order of an object
    // literal is insertion-order in modern JS; operator's config
    // ordering IS the precedence.
    for (const [group, role] of Object.entries(mapping.map)) {
      if (groups.includes(group)) {
        roleName = role
        break
      }
    }
    // Fall through to defaultRole if no group matched.
    if (!roleName) {
      roleName = mapping.defaultRole
    }
  }

  // Without a mapping (or with an empty map + null defaultRole),
  // there's no role to assign.
  if (!roleName) return null

  const capabilities = expandRole(roleName, customRoles)
  if (!capabilities) {
    // Unknown role — operator misconfiguration. The site-loader
    // should catch this at boot via strict validation; this is the
    // defense-in-depth check.
    return null
  }

  return { name: roleName, capabilities }
}

/**
 * Validate that a custom role's capabilities don't redefine
 * built-in roles with surprising semantics. Per design-auth-rbac.md
 * Q3: unknown capabilities flagged; reserved built-in role names
 * cannot be redeclared.
 *
 * Returns the list of validation issues; empty array means valid.
 * Caller decides strict-mode (throw) vs warn-mode (log) per
 * `admin.auth.strict`.
 */
export function validateCustomRoles(customRoles: Readonly<Record<string, ReadonlyArray<string>>>): string[] {
  const issues: string[] = []
  for (const name of Object.keys(customRoles)) {
    if (name in BUILT_IN_ROLES) {
      issues.push(
        `Custom role "${name}" conflicts with a built-in role. Choose a different name; built-in roles can't be redefined.`,
      )
    }
  }
  return issues
}
