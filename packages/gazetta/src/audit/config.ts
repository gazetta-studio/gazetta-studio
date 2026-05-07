/**
 * Zod schema for the `admin.audit` block in `site.config.ts`. Cut 1
 * ships only the v1 in-tree provider configuration shapes (none /
 * history); v2 external-sink providers (webhook, file, OTel,
 * CloudWatch, Azure Monitor, syslog) extend the union when they
 * land — the discriminator field stays `provider`.
 *
 * # Why `provider` is a string discriminator (not Path X factory)
 *
 * Per `design-audit.md`'s "Configuration" section:
 *
 *     admin: { audit: { provider: 'history' } }
 *
 * The string-discriminator predates Path X (factory-call config) per
 * the "Path X migration note" in design-audit.md. When the audit
 * foundation moves to Path X, the operator-facing shape becomes:
 *
 *     audit: auditChain([historyAudit(), cloudwatchAudit({...})], { strict: false })
 *
 * Cut 1 ships the pre-Path-X shape because:
 *   1. The Path X migration touches every Pattern-3 surface; doing
 *      it audit-only fragments the cutover
 *   2. The string-discriminator works correctly today; operators
 *      can use it without regret. The Path X migration is a future
 *      additive change (fan-out factory wraps single-provider for
 *      backwards compat at config-eval time)
 *
 * # SOLID lenses
 *
 *   - SRP: schema validation only. Doesn't construct providers.
 *   - OCP: adding a v2 provider extends the discriminated union;
 *     existing variants unchanged.
 */
import { z } from 'zod'

/**
 * Retention shape — separate from history retention per locked
 * invariant: compliance regimes specify retention windows that
 * differ from content-history budgets.
 */
const retentionSchema = z
  .object({
    /** Max audit events kept (per provider with own storage). */
    events: z.number().int().positive().optional(),
    /** Max age in months. `null` = no time limit. */
    maxAgeMonths: z.number().int().positive().nullable().optional(),
  })
  .strict()

/**
 * `history` provider — extends the existing `Revision` shape with
 * audit fields. v1 default; zero-config when audit isn't explicitly
 * configured.
 */
const historyAuditSchema = z
  .object({
    provider: z.literal('history'),
    retention: retentionSchema.optional(),
    /** `true` blocks writes when audit recording fails. Default false. */
    strict: z.boolean().optional(),
    /** Pseudonymization mode for actor.id. Default 'none'. */
    actorPseudonym: z.enum(['none', 'sha256']).optional(),
    /** Source IP recording mode (default off; see Cut 4). */
    recordSourceIp: z.enum(['none', 'raw', 'hashed', 'truncated']).optional(),
    /** Trusted proxy header for source IP extraction. */
    trustedProxyHeader: z.string().optional(),
    trustedProxyCount: z.number().int().nonnegative().optional(),
    /** User agent recording mode. */
    recordUserAgent: z.enum(['none', 'raw', 'truncated']).optional(),
  })
  .strict()

/**
 * Top-level audit config. v1 ships only the `history` variant;
 * the discriminated-union shape leaves room for v2 external-sink
 * providers without touching the consumer code path.
 */
export const AuditConfigSchema = historyAuditSchema

export type AuditConfig = z.infer<typeof AuditConfigSchema>

/**
 * Defaults per design-audit.md "Configuration":
 *   - `provider: 'history'` is implicit when admin.audit absent
 *   - `strict: false` (fail-open)
 *   - `actorPseudonym: 'none'` (raw subject)
 *   - `recordSourceIp: 'none'` (off)
 *   - `recordUserAgent: 'none'` (off)
 */
export const DEFAULT_AUDIT_CONFIG: AuditConfig = {
  provider: 'history',
  strict: false,
  actorPseudonym: 'none',
  recordSourceIp: 'none',
  recordUserAgent: 'none',
}
