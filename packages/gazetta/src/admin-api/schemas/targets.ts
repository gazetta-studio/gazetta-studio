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

/** Entry in the list response for GET /api/targets. */
export const TargetInfoSchema = z.object({
  name: z.string(),
  environment: TargetEnvironmentSchema,
  type: TargetTypeSchema,
  editable: z.boolean(),
  /** AI alt-text capability resolved from site + target config. */
  altText: AltTextCapabilitySchema,
})
export type TargetInfo = z.infer<typeof TargetInfoSchema>
