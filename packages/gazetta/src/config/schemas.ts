/**
 * Zod schemas for site.config.ts and gazetta.config.ts validation.
 *
 * Per design-config.md and ADR-0005: TS types catch shape errors at
 * edit time; Zod catches env-var-driven errors and shape errors not
 * expressible in TS at load time. Defense in depth.
 *
 * Validation philosophy: enforce the load-bearing structural fields
 * (name, targets, dimensions). Pass-through for nested fields that
 * have their own validation downstream (e.g., target storage configs
 * are validated by their respective providers; AI configs by the alt
 * adapter factory).
 *
 * This keeps the schema small and forward-compatible — adding a new
 * field anywhere in the config tree doesn't require updating this
 * schema.
 */

import { z } from 'zod'

/**
 * Locale code per BCP 47 — accepts `en`, `en-gb`, `pt-br`, etc.
 * Permissive; downstream resolves the canonical form.
 */
const LocaleCodeSchema = z.string().regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/, {
  message: 'Locale code must be BCP 47 (e.g., "en", "en-gb", "pt-br")',
})

/**
 * Theme name — lowercase ASCII; must NOT collide with a BCP 47 locale code
 * (locked invariant per design-media.md). Validation here checks the
 * lowercase-ASCII rule; the full locale-collision check runs at
 * `resolveSiteThemes` time when the config + locales are joined.
 */
const ThemeNameSchema = z.string().regex(/^[a-z][a-z0-9-]*$/, {
  message: 'Theme name must be lowercase ASCII letters/digits/hyphens',
})

/**
 * Per-site config — `sites/{name}/site.config.ts` (or `site.config.ts`
 * at project root for flat layouts).
 *
 * Required for any site to exist. Carries per-site concerns: targets,
 * dimensions (themes/locales), auth, plugins, hooks, audit, SEO defaults.
 */
export const SiteConfigSchema = z
  .object({
    name: z.string().min(1, 'Site name is required'),
    version: z.string().optional(),
    locale: LocaleCodeSchema.optional(),
    locales: z
      .object({
        supported: z.array(LocaleCodeSchema).min(1),
        fallbacks: z.record(z.string(), LocaleCodeSchema).optional(),
        defaultPrefix: z.boolean().optional(),
        detection: z.boolean().optional(),
      })
      .optional(),
    themes: z
      .object({
        supported: z.array(ThemeNameSchema).min(1),
        default: ThemeNameSchema.optional(),
      })
      .optional(),
    defaultOgImage: z.string().optional(),
    /**
     * AI cross-task block. Validated downstream by the alt adapter
     * factory; here we only check it's an object when present.
     */
    ai: z.record(z.string(), z.unknown()).optional(),
    altText: z.record(z.string(), z.unknown()).optional(),
    systemPages: z.array(z.string()).optional(),
    /**
     * Per-target configurations. Keys are target names; values are
     * TargetConfig shapes validated downstream by storage providers,
     * transform adapters, etc.
     */
    targets: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    /**
     * AdminCache instance (Path X — operator constructs via factory call,
     * e.g., `cache: memoryCache({...})`). Validated downstream by checking
     * for the AdminCache method shape; Zod's role here is to accept the
     * opaque constructed instance.
     */
    cache: z.unknown().optional(),
    /**
     * Reserved for future foundations (auth, plugins, hooks, audit,
     * notifications). Each block is validated by its own factory at
     * load time per the Universal Provider Requirements.
     */
    admin: z
      .object({
        auth: z.record(z.string(), z.unknown()).optional(),
        plugins: z.array(z.unknown()).optional(),
        hooks: z.record(z.string(), z.unknown()).optional(),
        audit: z.record(z.string(), z.unknown()).optional(),
        notifications: z.record(z.string(), z.unknown()).optional(),
        offline: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
  })
  .strict()

/**
 * Project-level Gazetta config — `gazetta.config.ts` at project root.
 *
 * Optional; absent means use built-in defaults.
 */
export const GazettaConfigSchema = z
  .object({
    logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error']).optional(),
    telemetry: z.boolean().optional(),
    dev: z
      .object({
        port: z.number().int().min(1).max(65535).optional(),
        hostname: z.string().optional(),
      })
      .optional(),
    /**
     * Defaults that sites inherit unless they override. Object fields
     * merge per-field; arrays (plugins, hooks) do NOT inherit (locked
     * per design-config.md "Defaults flow").
     *
     * `defaults.cache` is a constructed AdminCache instance (Path X —
     * `defaults: { cache: memoryCache({...}) }`). Per the single-Site-
     * per-process invariant in `CONTEXT.md`, each process re-evaluates
     * `gazetta.config.ts` and gets a fresh instance; no per-Site
     * reconstruction needed. Zod accepts the opaque instance.
     */
    defaults: z
      .object({
        cache: z.unknown().optional(),
        audit: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
    mcp: z
      .object({
        enabled: z.boolean().optional(),
        port: z.number().int().min(1).max(65535).optional(),
      })
      .optional(),
  })
  .strict()
