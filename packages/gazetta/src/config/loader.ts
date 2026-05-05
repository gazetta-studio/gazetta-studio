/**
 * Site config + Gazetta config loader.
 *
 * Per design-config.md, design-config-implementation.md Cut 2, and
 * locked Q1-Q4:
 *
 * - jiti for TS evaluation (reuses template-loader's pattern)
 * - dotenv loaded BEFORE config eval (Q4 lock; project-root only;
 *   CI-skip preserved)
 * - Discovery rules per Q2 lock:
 *   - Both root site.config.ts AND sites/ dir present → ConfigLayoutError
 *   - sites/ dir exists → walk subdirectories with site.config.ts;
 *     skip + warn for any subdir without it
 *   - Otherwise → flat layout: site.config.ts at project root
 * - gazetta.config.ts at project root is optional; absent = built-in defaults
 * - Zod validation on every load (defense in depth alongside TS types)
 * - Defaults flow per design-config.md: object-fields inherit from
 *   gazetta.defaults; arrays (plugins, hooks) are explicit per site
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createJiti } from 'jiti'
import { ConfigEvaluationError, ConfigLayoutError, ConfigValidationError } from './errors.js'
import { GazettaConfigSchema, SiteConfigSchema } from './schemas.js'
import type { GazettaConfig, SiteConfig } from './types.js'

const SITE_CONFIG_FILES = ['site.config.ts', 'site.config.js', 'site.config.mjs']
const GAZETTA_CONFIG_FILES = ['gazetta.config.ts', 'gazetta.config.js', 'gazetta.config.mjs']

/** A discovered site within a project. */
export interface DiscoveredSite {
  /** Site name — directory name for sites/ layout, config.name for flat layout. */
  name: string
  /** Absolute path to the site directory containing pages/, fragments/, etc. */
  dir: string
  /** Absolute path to the site.config.ts file. */
  configPath: string
  /** Loaded + validated site config. */
  config: SiteConfig
}

/** Result of project-wide config loading. */
export interface LoadedProjectConfig {
  /** Project root (absolute path). */
  projectRoot: string
  /** Loaded gazetta.config.ts, or null if absent (use built-in defaults). */
  gazetta: GazettaConfig | null
  /** All discovered sites, in stable directory-name order. */
  sites: DiscoveredSite[]
}

/**
 * Find the first existing config file in a directory matching the
 * known extensions (.ts / .js / .mjs).
 */
function findConfigFile(dir: string, candidates: readonly string[]): string | null {
  for (const name of candidates) {
    const full = join(dir, name)
    if (existsSync(full)) return full
  }
  return null
}

/**
 * Evaluate a TypeScript / JavaScript config file via jiti.
 *
 * Returns the default export. Throws ConfigEvaluationError on parse /
 * runtime errors.
 */
async function evaluateConfig(filePath: string): Promise<unknown> {
  const jiti = createJiti(pathToFileURL(filePath).href, {
    jsx: false,
    moduleCache: false,
  })
  // Anchor relative filesystem paths inside the config to the config file's
  // directory (so `filesystemStorage({ path: './dist' })` resolves the same
  // way regardless of which directory the CLI was invoked from). Cleared in
  // a finally block so test harnesses + concurrent loads don't leak state.
  const { setConfigAnchor, configAnchorFromFile } = await import('../providers/factories.js')
  setConfigAnchor(configAnchorFromFile(filePath))
  let mod: Record<string, unknown>
  try {
    mod = (await jiti.import(filePath)) as Record<string, unknown>
  } catch (err) {
    throw new ConfigEvaluationError(`Failed to evaluate config: ${(err as Error).message}`, filePath, { cause: err })
  } finally {
    setConfigAnchor(null)
  }
  if (!mod || typeof mod !== 'object') {
    throw new ConfigEvaluationError('Config module did not produce a default export', filePath)
  }
  // Default export shape: jiti normalizes both `export default { ... }` and
  // `module.exports = { ... }` to a `.default` field on the namespace object.
  const value = 'default' in mod ? mod.default : mod
  if (!value || typeof value !== 'object') {
    throw new ConfigEvaluationError(
      'Config default export must be an object (use defineSite() or defineGazetta())',
      filePath,
    )
  }
  return value
}

/**
 * Validate a loaded config object against its Zod schema.
 *
 * Throws ConfigValidationError with the file path on schema failure.
 */
function validateSiteConfig(value: unknown, filePath: string): SiteConfig {
  const result = SiteConfigSchema.safeParse(value)
  if (!result.success) {
    const issues = result.error.issues.map(issue => `  ${issue.path.join('.')}: ${issue.message}`).join('\n')
    throw new ConfigValidationError(`Site config validation failed:\n${issues}`, filePath)
  }
  return result.data
}

function validateGazettaConfig(value: unknown, filePath: string): GazettaConfig {
  const result = GazettaConfigSchema.safeParse(value)
  if (!result.success) {
    const issues = result.error.issues.map(issue => `  ${issue.path.join('.')}: ${issue.message}`).join('\n')
    throw new ConfigValidationError(`Gazetta config validation failed:\n${issues}`, filePath)
  }
  return result.data
}

/**
 * Load gazetta.config.ts from the project root.
 *
 * Returns null if no config file is present (built-in defaults apply).
 */
export async function loadGazettaConfig(projectRoot: string): Promise<GazettaConfig | null> {
  const configPath = findConfigFile(projectRoot, GAZETTA_CONFIG_FILES)
  if (!configPath) return null
  const value = await evaluateConfig(configPath)
  return validateGazettaConfig(value, configPath)
}

/**
 * Load a single site.config.ts from a site directory.
 *
 * Per Q2 lock: if the site directory exists but has no config file,
 * returns null (caller decides whether to warn + skip).
 */
export async function loadSiteConfig(siteDir: string): Promise<{
  config: SiteConfig
  configPath: string
} | null> {
  const configPath = findConfigFile(siteDir, SITE_CONFIG_FILES)
  if (!configPath) return null
  const value = await evaluateConfig(configPath)
  const config = validateSiteConfig(value, configPath)
  return { config, configPath }
}

/**
 * Apply gazetta.config.defaults to a site config (object-fields only;
 * arrays do not inherit per design-config.md "Defaults flow").
 */
function applyGazettaDefaults(site: SiteConfig, defaults: GazettaConfig['defaults']): SiteConfig {
  if (!defaults) return site
  const admin = site.admin ?? {}
  return {
    ...site,
    admin: {
      ...admin,
      cache: admin.cache ?? defaults.cache,
      audit: admin.audit ?? defaults.audit,
    },
  }
}

/**
 * Discover and load all sites in a project.
 *
 * Implements Q2 layout-resolution rules:
 * - Both root site.config.ts AND sites/ dir present → ConfigLayoutError
 * - sites/ dir exists → walk subdirectories; warn + skip any without site.config.ts
 * - Otherwise → flat layout: single site at project root
 */
export async function discoverSites(
  projectRoot: string,
  gazetta: GazettaConfig | null,
  options?: { logger?: (msg: string) => void },
): Promise<DiscoveredSite[]> {
  const log = options?.logger ?? ((msg: string) => console.warn(msg))
  const rootConfigPath = findConfigFile(projectRoot, SITE_CONFIG_FILES)
  const sitesDir = join(projectRoot, 'sites')
  const sitesDirExists = existsSync(sitesDir) && statSync(sitesDir).isDirectory()

  // Q2 conflict check
  if (rootConfigPath && sitesDirExists) {
    throw new ConfigLayoutError(
      `Conflicting layout: both ${rootConfigPath} (flat) AND ${sitesDir}/ (multi-site) are present. Pick one — either delete the root site.config.ts to use multi-site, or delete the sites/ directory to use flat layout.`,
    )
  }

  const defaults = gazetta?.defaults

  // Flat layout: single site at project root
  if (rootConfigPath) {
    const value = await evaluateConfig(rootConfigPath)
    const config = applyGazettaDefaults(validateSiteConfig(value, rootConfigPath), defaults)
    return [
      {
        name: config.name,
        dir: projectRoot,
        configPath: rootConfigPath,
        config,
      },
    ]
  }

  // Multi-site layout: walk sites/
  if (!sitesDirExists) {
    log(`No site config found: neither ${SITE_CONFIG_FILES[0]} at project root nor sites/ directory exists.`)
    return []
  }

  const subdirs = readdirSync(sitesDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()

  if (subdirs.length === 0) {
    log(`Empty sites/ directory at ${sitesDir} — no sites to load.`)
    return []
  }

  const sites: DiscoveredSite[] = []
  for (const dirName of subdirs) {
    const siteDir = join(sitesDir, dirName)
    const loaded = await loadSiteConfig(siteDir)
    if (!loaded) {
      log(`Skipping ${siteDir}: no ${SITE_CONFIG_FILES[0]} found.`)
      continue
    }
    sites.push({
      name: loaded.config.name,
      dir: siteDir,
      configPath: loaded.configPath,
      config: applyGazettaDefaults(loaded.config, defaults),
    })
  }
  return sites
}

/**
 * Load the full project config — gazetta.config.ts (optional) + all
 * discovered sites.
 *
 * This is the top-level entry point that boot flows use. dotenv must
 * already have been loaded before this is called (per Q4 lock).
 */
export async function loadProjectConfig(
  projectRoot: string,
  options?: { logger?: (msg: string) => void },
): Promise<LoadedProjectConfig> {
  const absRoot = resolve(projectRoot)
  const gazetta = await loadGazettaConfig(absRoot)
  const sites = await discoverSites(absRoot, gazetta, options)
  return {
    projectRoot: absRoot,
    gazetta,
    sites,
  }
}

/**
 * Adapter: convert the user's SiteConfig (input shape) into the
 * runtime SiteManifest shape consumed by site-loader.ts and
 * downstream code.
 *
 * The two shapes are equivalent at runtime — SiteManifest types nested
 * provider blocks (ai, altText, targets, themes.default) more strictly
 * than SiteConfig (which uses Record<string, unknown> for forward-
 * compatibility with foundations that haven't shipped yet).
 *
 * The conversion is structural: pass the values through; cast nested
 * provider blocks to their runtime types. Downstream validation (alt
 * adapter factory, etc.) still runs and rejects malformed nested data.
 *
 * Per design-config-implementation.md Cut 4 — wires the new TS-config
 * loader into existing site-loader.ts without breaking downstream
 * consumers that read site.manifest.{name, locale, targets, ...}.
 */
export function siteConfigToManifest(config: SiteConfig): import('../types.js').SiteManifest {
  // The shapes overlap nearly entirely; runtime values flow through.
  // The cast through `unknown` is required because SiteConfig's
  // permissive `Record<string, unknown>` blocks (ai, altText,
  // targets) don't satisfy SiteManifest's stricter typed shapes by
  // simple assignment, but the runtime data is identical.
  return config as unknown as import('../types.js').SiteManifest
}
