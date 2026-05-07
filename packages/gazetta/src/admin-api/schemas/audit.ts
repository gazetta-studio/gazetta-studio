/**
 * Zod schemas for `/api/audit*` endpoints.
 *
 * The query endpoint returns events from all configured queryable
 * providers; external-sink providers (no `query()`) contribute their
 * `queryUrl()` deep-link instead. Per design-audit.md "Audit drawer
 * — query semantics", the response carries both arrays so the
 * drawer can render the four states (history-only, mixed, external-
 * only-with-link, external-only-no-link) deterministically.
 *
 * The schemas mirror the runtime types in `audit/types.ts`. We
 * re-declare them here as Zod (not `z.infer` from a runtime type)
 * because the wire shape is what's contract-tested; the runtime
 * types and the Zod schemas could legitimately diverge at the wire
 * boundary (e.g., `metadata` is `Record<string, unknown>` at runtime
 * but the Zod schema validates it as `z.record(z.unknown())` so
 * unparseable JSON gets rejected with a clear 400 instead of
 * silently flowing through as `unknown`).
 */
import { z } from 'zod'

export const AuditActionSchema = z.enum(['save', 'publish', 'delete', 'restore', 'configure-roles', 'hook-fired'])
export type AuditActionWire = z.infer<typeof AuditActionSchema>

export const AuditOutcomeSchema = z.enum([
  'success',
  'forbidden',
  'validation-failed',
  'unauthenticated',
  'hook-cancelled',
  'timeout',
])
export type AuditOutcomeWire = z.infer<typeof AuditOutcomeSchema>

export const AuditScopeKindSchema = z.enum(['page', 'fragment', 'asset', 'site'])
export type AuditScopeKindWire = z.infer<typeof AuditScopeKindSchema>

export const AuditActorSchema = z.object({
  id: z.string(),
  email: z.string().optional(),
  role: z.string(),
  trustMode: z.string(),
})
export type AuditActorWire = z.infer<typeof AuditActorSchema>

export const AuditScopeSchema = z.object({
  kind: AuditScopeKindSchema,
  name: z.string().optional(),
})
export type AuditScopeWire = z.infer<typeof AuditScopeSchema>

export const AuditEventSchema = z.object({
  timestamp: z.string(),
  actor: AuditActorSchema,
  action: AuditActionSchema,
  outcome: AuditOutcomeSchema,
  scope: AuditScopeSchema,
  sourceIp: z.string().optional(),
  userAgent: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})
export type AuditEventWire = z.infer<typeof AuditEventSchema>

/**
 * Reference to an external-sink provider whose events live elsewhere.
 * The drawer renders these as deep-links beside the inline events
 * list. `url` is null when the provider has neither `query()` nor a
 * usable `queryUrl()` — the drawer surfaces "configured but not
 * queryable" so operators see what's wired up even when there's
 * nothing inline.
 */
export const AuditExternalSinkSchema = z.object({
  /** Provider name (matches `AuditProvider.name`). */
  name: z.string(),
  /**
   * Operator-facing deep-link to the external sink's console, when
   * available. `null` when `queryUrl()` returned null or wasn't
   * implemented.
   */
  url: z.string().nullable(),
})
export type AuditExternalSinkWire = z.infer<typeof AuditExternalSinkSchema>

/**
 * Response body for `GET /api/audit`. Carries inline events from
 * queryable providers + sink references for external-only providers.
 * The drawer composes both into one user-facing surface.
 */
export const AuditQueryResponseSchema = z.object({
  events: z.array(AuditEventSchema),
  /** External sinks whose events are NOT in the inline events array. */
  externalSinks: z.array(AuditExternalSinkSchema),
})
export type AuditQueryResponseWire = z.infer<typeof AuditQueryResponseSchema>
