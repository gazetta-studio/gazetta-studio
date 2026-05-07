/**
 * Zod schema for the `admin.auth` block in `site.config.ts`. This
 * cut ships only the `none`-mode shape; subsequent cuts add Zod
 * variants for `forwarded-user`, `cloudflare-access`, etc.
 *
 * # Why a discriminated union
 *
 * Each trust mode's configuration shape is genuinely different
 * (`forwarded-user` has `trustedProxyCount`; `cloudflare-access`
 * has `teamDomain`; `none` has no provider-specific fields). A
 * discriminated union on `trust:` lets TypeScript narrow per
 * mode automatically and gives operators IDE autocomplete for the
 * fields their chosen mode accepts.
 *
 * # Defaults
 *
 * Operators who don't set `admin.auth` run in `none` mode. The
 * site-loader treats absent `admin.auth` as `{ trust: 'none' }`.
 *
 * # SOLID lenses
 *
 *   - SRP: schema validation only; doesn't construct providers.
 *   - OCP: adding a trust mode appends one variant to the union;
 *     existing variants unchanged.
 */
import { z } from 'zod'
import { RESERVED_CAPABILITY_PREFIXES } from './types.js'

/**
 * Capability-shape regex. Either a wildcard (`'*'`) or
 * `<prefix>:<rest>` where `rest` may itself be a wildcard.
 * Plugin-supplied capabilities use scoped prefixes (e.g.,
 * `@my-org/search:rebuild-index`); the schema accepts those too.
 */
const capabilityRegex = /^(\*|[a-zA-Z@][a-zA-Z0-9@/_-]*:[a-zA-Z*][a-zA-Z0-9_-]*)$/

const capabilitySchema = z.string().regex(capabilityRegex, 'Capability must be either "*" or "<prefix>:<rest>"')

/**
 * Custom role definition — operator-declared in `site.config.ts`.
 * Built-in roles (`admin`, `editor`, `viewer`) are predefined and
 * don't appear here; operators only declare custom roles.
 */
const roleSchema = z
  .object({
    capabilities: z.array(capabilitySchema).readonly(),
  })
  .strict()

const roleMappingSchema = z
  .object({
    /** Which JSON claim / header field carries the upstream group list. */
    claim: z.string(),
    /** Map from upstream group name to Gazetta role name. */
    map: z.record(z.string(), z.string()),
    /** Fallback role when no group matches. `null` denies access. */
    defaultRole: z.string().nullable().optional(),
  })
  .strict()

/**
 * `none` trust mode — the default. No provider-specific fields.
 * Operators omitting `admin.auth` entirely fall back to this shape
 * with all defaults.
 */
const noneAuthSchema = z
  .object({
    trust: z.literal('none'),
    /** Custom role declarations (rare in `none` mode but allowed). */
    roles: z.record(z.string(), roleSchema).optional(),
    /** Strict mode — invalid roles fail boot vs. log warning. */
    strict: z.boolean().optional(),
  })
  .strict()

/**
 * `forwarded-user` trust mode — generic reverse-proxy mode. The
 * upstream layer (oauth2-proxy, Authelia, Caddy with `forward_auth`,
 * etc.) populates `X-Forwarded-User` and optionally
 * `X-Forwarded-Email` / `X-Forwarded-Groups`.
 *
 * # Header-spoofing protection
 *
 * Operators MUST configure source-IP protection per
 * `design-auth-rbac.md` Q1: either `trustedProxies` (whitelist of
 * IPs/CIDRs that may set the headers) OR `allowAnyOrigin: true`
 * (explicit opt-in for dev / private networks).
 *
 * Default: fail-closed. Without `trustedProxies` AND without
 * `allowAnyOrigin`, the provider rejects every request — surfaces
 * as 401 with a config-hint message. This matches Q4's
 * "fail-closed" recommendation in the design's "Source-IP whitelist
 * semantics" open question.
 */
const forwardedUserAuthSchema = z
  .object({
    trust: z.literal('forwarded-user'),
    /**
     * IPs or CIDR blocks that may set the forwarded headers. Each
     * entry is an IP literal (`192.168.1.10`) or CIDR
     * (`10.0.0.0/8`, `fd00::/8`). Empty array + missing
     * `allowAnyOrigin` → all requests rejected.
     */
    trustedProxies: z.array(z.string()).optional(),
    /**
     * Explicit opt-out of source-IP protection. Use ONLY in dev or
     * trusted private networks (Tailscale, internal VPNs).
     * Production deployments behind a public load balancer MUST
     * use `trustedProxies` instead.
     */
    allowAnyOrigin: z.boolean().optional(),
    roles: z.record(z.string(), roleSchema).optional(),
    roleMapping: roleMappingSchema.optional(),
    strict: z.boolean().optional(),
  })
  .strict()
  .refine(cfg => cfg.allowAnyOrigin || (cfg.trustedProxies && cfg.trustedProxies.length > 0), {
    message:
      'forwarded-user trust mode requires trustedProxies (IP whitelist) OR allowAnyOrigin: true. Without either, every request is rejected — likely a misconfiguration. Set trustedProxies for production deployments behind a known proxy; set allowAnyOrigin: true only in dev or trusted private networks.',
    path: ['trustedProxies'],
  })

/**
 * Top-level discriminated union. Subsequent cuts add variants for
 * `cloudflare-access`, `azure-easy-auth`, `aws-cognito`, `tailscale`.
 * Each variant adds a literal-`trust` discriminator + its own
 * provider-specific fields.
 */
export const AuthConfigSchema = z.discriminatedUnion('trust', [noneAuthSchema, forwardedUserAuthSchema])

export type AuthConfig = z.infer<typeof AuthConfigSchema>

/**
 * Reserved-prefix check. Future plugin-supplied capabilities use
 * plugin-scoped prefixes (e.g., `@my-org/...:`); custom roles MUST
 * NOT redefine reserved built-in prefixes with conflicting
 * semantics. The role-resolver enforces this at load time.
 */
export function isReservedPrefix(capability: string): boolean {
  if (capability === '*') return true
  const colonIdx = capability.indexOf(':')
  if (colonIdx <= 0) return false
  const prefix = capability.slice(0, colonIdx)
  return (RESERVED_CAPABILITY_PREFIXES as readonly string[]).includes(prefix)
}
