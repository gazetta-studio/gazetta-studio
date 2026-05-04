/**
 * Shared helper for tests that use the starter site.
 * Loads the project-level site.config.ts once via the TS config loader —
 * targets don't have their own config.
 */

import { resolve } from 'node:path'
import { loadSiteConfig, siteConfigToManifest } from '../../src/config/loader.js'
import type { SiteManifest } from '../../src/types.js'

export const starterProjectRoot = resolve(import.meta.dirname, '../../../../examples/starter')
export const starterSiteDir = resolve(starterProjectRoot, 'sites/main')
export const starterTargetDir = resolve(starterSiteDir, 'targets/local')
export const starterTemplatesDir = resolve(starterProjectRoot, 'templates')

let cached: SiteManifest | null = null

/** Load the starter's project-level manifest (cached). */
export async function starterManifest(): Promise<SiteManifest> {
  if (cached) return cached
  const loaded = await loadSiteConfig(starterSiteDir)
  if (!loaded) throw new Error(`No site.config.ts at ${starterSiteDir}`)
  cached = siteConfigToManifest(loaded.config)
  return cached
}
