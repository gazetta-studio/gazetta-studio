/**
 * Site config + Gazetta config public exports.
 *
 * Per ADR-0005 and design-config.md: TS config (`gazetta.config.ts` +
 * `site.config.ts`) replaces YAML; identity functions provide IDE
 * inference; runtime Zod validation runs at load.
 */

export { defineSite, defineGazetta } from './define.js'
export type { SiteConfig, GazettaConfig } from './types.js'
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
} from './loader.js'
export type { DiscoveredSite, LoadedProjectConfig } from './loader.js'
