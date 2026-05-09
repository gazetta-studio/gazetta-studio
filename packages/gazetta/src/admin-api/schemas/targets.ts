/**
 * Zod schemas for /api/targets list endpoint.
 *
 * The literal unions mirror `TargetEnvironment` and `TargetType` in
 * types.ts — keeping them as z.enum here means the wire shape is the
 * authoritative spec and types.ts just re-exports the inferred types.
 * Don't duplicate the literals on the client.
 */
import { z } from 'zod'

export const TargetEnvironmentSchema = z.enum(['local', 'staging', 'production'])
export type TargetEnvironment = z.infer<typeof TargetEnvironmentSchema>

export const TargetTypeSchema = z.enum(['static', 'dynamic'])
export type TargetType = z.infer<typeof TargetTypeSchema>

/**
 * AI alt-text capability for a target. Surfaced via /api/targets so
 * the UI can render affordances based on configuration without probing
 * via 503 fallback.
 *
 *   - `available`: true when the target has a configured adapter AND
 *     credentials are present in the environment. False otherwise — the
 *     UI hides AI affordances.
 *   - `auto`: when `true` and `available`, upload flows fire suggest
 *     after the upload completes. When `false`, suggestion is on-demand
 *     only (detail-pane button).
 */
export const AltTextCapabilitySchema = z.object({
  available: z.boolean(),
  auto: z.boolean(),
})
export type AltTextCapability = z.infer<typeof AltTextCapabilitySchema>

/**
 * Per-capability runtime gap reason — surfaces in the admin's archive
 * modal (capability-gap UX surface #2 per `feature-design-process.md`).
 * `capability` is one of the closed-enum values from
 * `runtime-capabilities.ts` (`'redirects' | 'gone-status'` today;
 * extends as new capabilities ship). `reason` is human-readable; the
 * modal renders it under the per-target capability badge.
 */
export const CapabilityGapSchema = z.object({
  capability: z.string(),
  reason: z.string(),
})
export type CapabilityGap = z.infer<typeof CapabilityGapSchema>

/**
 * Runtime-capability inspection for a target — surface #2 of the
 * four-point capability-gap UX pattern. `has` is the array of
 * supported capabilities; `gaps` enumerates the missing ones with
 * reasons. The admin UI renders per-target badges using both fields.
 */
export const TargetCapabilitiesSchema = z.object({
  has: z.array(z.string()),
  gaps: z.array(CapabilityGapSchema),
})
export type TargetCapabilitiesInfo = z.infer<typeof TargetCapabilitiesSchema>

/** Entry in the list response for GET /api/targets. */
export const TargetInfoSchema = z.object({
  name: z.string(),
  environment: TargetEnvironmentSchema,
  type: TargetTypeSchema,
  editable: z.boolean(),
  /** AI alt-text capability resolved from site + target config. */
  altText: AltTextCapabilitySchema,
  /**
   * Runtime capability inspection — what archive operations etc.
   * can do on this target. Per `design-soft-delete.md` Q10's
   * capability-gap UX principle.
   */
  capabilities: TargetCapabilitiesSchema,
})
export type TargetInfo = z.infer<typeof TargetInfoSchema>
