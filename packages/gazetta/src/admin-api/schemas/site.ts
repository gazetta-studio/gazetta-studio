/**
 * Zod schemas for /api/site — the site manifest shape as seen by the
 * admin UI.
 *
 * Mirrors what siteConfigToManifest() emits plus the empty-target fallback
 * (which includes an otherwise-absent `targets: {}` field).
 */
import { z } from 'zod'

export const LocalesConfigSchema = z.object({
  supported: z.array(z.string()),
  /** Default locale; falls back to supported[0] when omitted. */
  default: z.string().optional(),
  fallbacks: z.record(z.string(), z.string()).optional(),
  defaultPrefix: z.boolean().optional(),
  detection: z.boolean().optional(),
})

export const SiteManifestSchema = z
  .object({
    name: z.string(),
    version: z.string().optional(),
    locales: LocalesConfigSchema.optional(),
    systemPages: z.array(z.string()).optional(),
  })
  .loose()
export type SiteManifest = z.infer<typeof SiteManifestSchema>
