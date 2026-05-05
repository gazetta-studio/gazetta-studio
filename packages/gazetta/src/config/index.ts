/**
 * Site config + Gazetta config public exports.
 *
 * Per ADR-0005 and design-config.md: TS config (`gazetta.config.ts` +
 * `site.config.ts`) replaces YAML; identity functions provide IDE
 * inference; runtime Zod validation runs at load.
 */

export { defineSite, defineGazetta } from './define.js'
// `SiteConfig` / `GazettaConfig` (z.infer-derived input shapes) are no
// longer publicly exported. Per Path X, the user-input shape and the
// runtime manifest shape converged when provider fields became factory
// instances — there's no separate "loose" input type worth aliasing.
// Operators get types via `defineSite` / `defineGazetta` inference from
// `SiteManifest` / `GazettaManifest` (runtime shapes from `gazetta`).
// Internal callers in `packages/gazetta/src/config/` import `SiteConfig`
// / `GazettaConfig` from `./types.js` directly.
export { SiteConfigSchema, GazettaConfigSchema } from './schemas.js'
export {
  ConfigError,
  ConfigValidationError,
  ConfigEvaluationError,
  ConfigLayoutError,
} from './errors.js'
export {
  loadGazettaConfig,
  loadSiteConfig,
  discoverSites,
  loadProjectConfig,
  siteConfigToManifest,
  gazettaConfigToManifest,
} from './loader.js'
export type { DiscoveredSite, LoadedProjectConfig } from './loader.js'
