/**
 * Site config + Gazetta config TypeScript interfaces — the user-facing
 * shape that operators write in `site.config.ts` and `gazetta.config.ts`.
 *
 * Per ADR-0005 and design-config.md:
 * - These types are returned by `defineSite()` / `defineGazetta()` typed
 *   identity functions; consumers get full TS inference.
 * - Runtime Zod validation runs on every load (defense in depth — TS
 *   catches shape errors at edit time; Zod catches env-var-driven errors
 *   at load time).
 * - SiteConfig mirrors the runtime SiteManifest shape but is the user's
 *   input contract (more flexible defaults, optional fields).
 */

import type { z } from 'zod'
import type { GazettaConfigSchema, SiteConfigSchema } from './schemas.js'

/**
 * Project-level Gazetta config — `gazetta.config.ts` at project root.
 * Optional; absent means use built-in defaults.
 *
 * Carries cross-site concerns: telemetry, log level, dev port, MCP
 * server settings, default cache/audit providers that sites inherit.
 */
export type GazettaConfig = z.infer<typeof GazettaConfigSchema>

/**
 * Per-site config — `sites/{name}/site.config.ts` (or `site.config.ts`
 * at project root for flat layouts).
 *
 * Required for any site to exist. Carries per-site concerns: targets,
 * dimensions (themes/locales), auth, plugins, hooks, audit, SEO defaults.
 */
export type SiteConfig = z.infer<typeof SiteConfigSchema>
