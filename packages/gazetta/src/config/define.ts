/**
 * Typed identity functions for site.config.ts and gazetta.config.ts.
 *
 * Per ADR-0005 and design-config.md: returns the input unchanged but
 * provides TS inference for IDE autocomplete via generic constraint.
 *
 * Pattern matches Sanity / Astro / Vite / Vitest's `defineConfig` —
 * familiar to operators coming from adjacent tooling.
 *
 * Runtime Zod validation runs separately in the loader (per the Cut 2
 * design); identity functions here are zero-cost at runtime.
 */

import type { GazettaConfig, SiteConfig } from './types.js'

/**
 * Define a site's configuration. Returns the input unchanged.
 *
 * @example
 * ```ts
 * import { defineSite } from 'gazetta'
 *
 * export default defineSite({
 *   name: 'main',
 *   defaultLocale: 'en',
 *   targets: {
 *     local: { storage: { type: 'filesystem', path: './dist/local' } },
 *     production: { storage: { type: 'r2', bucket: process.env.R2_BUCKET! } },
 *   },
 * })
 * ```
 */
export function defineSite<T extends SiteConfig>(config: T): T {
  return config
}

/**
 * Define project-level Gazetta configuration. Returns the input unchanged.
 *
 * @example
 * ```ts
 * import { defineGazetta } from 'gazetta'
 *
 * export default defineGazetta({
 *   logLevel: 'info',
 *   defaults: {
 *     cache: { provider: 'memory' },
 *     audit: { provider: 'history' },
 *   },
 * })
 * ```
 */
export function defineGazetta<T extends GazettaConfig>(config: T): T {
  return config
}
