import { resolve, join } from 'node:path'
import { existsSync } from 'node:fs'
import type { SiteManifest } from '../types.js'

/**
 * Load a site manifest from `siteDir` via the TS config loader. Recognizes
 * `site.config.ts`, `site.config.js`, and `site.config.mjs`.
 *
 * Returns null when no config file is found.
 */
export async function loadSiteManifestForCli(siteDir: string): Promise<SiteManifest | null> {
  const tsConfigCandidates = ['site.config.ts', 'site.config.js', 'site.config.mjs']
  if (!tsConfigCandidates.some(f => existsSync(join(siteDir, f)))) return null
  const { loadSiteConfig, siteConfigToManifest } = await import('../config/loader.js')
  const loaded = await loadSiteConfig(siteDir)
  if (!loaded) return null
  return siteConfigToManifest(loaded.config)
}

/** Returns true if the directory contains a Gazetta site config (`site.config.ts`/.js/.mjs). */
export function hasSiteConfig(dir: string): boolean {
  return (
    existsSync(join(dir, 'site.config.ts')) ||
    existsSync(join(dir, 'site.config.js')) ||
    existsSync(join(dir, 'site.config.mjs'))
  )
}

/**
 * Resolve the site directory from positional args or auto-detection.
 * For commands like `dev` and `validate`, the first positional is the site.
 * For commands like `publish` and `serve`, the first positional is the target
 * and the second is the site.
 */
export async function resolveSiteDir(positionalSite: string | undefined, command: string): Promise<string> {
  // Explicit site dir provided
  if (positionalSite) {
    const dir = resolve(positionalSite)
    if (hasSiteConfig(dir)) return dir
    // Maybe it's a site name under sites/
    const sitesSubdir = resolve('sites', positionalSite)
    if (hasSiteConfig(sitesSubdir)) return sitesSubdir
    // Maybe it's a project root with sites/
    const mainSite = resolve(dir, 'sites/main')
    if (hasSiteConfig(mainSite)) return mainSite
    return dir // let loadSite produce a clear error
  }

  // Auto-detect: check current dir first
  if (hasSiteConfig(resolve('.'))) return resolve('.')

  // Check sites/ directory
  const sitesDir = resolve('sites')
  if (existsSync(sitesDir)) {
    const { readdirSync, statSync } = await import('node:fs')
    const sites = readdirSync(sitesDir).filter(name => {
      const dir = join(sitesDir, name)
      return statSync(dir).isDirectory() && hasSiteConfig(dir)
    })

    if (sites.length === 1) return join(sitesDir, sites[0])
    if (sites.length > 1) {
      if (process.env.CI) {
        console.error(
          `\n  Error: multiple sites found. Specify one: gazetta ${command} <site>\n  Available: ${sites.join(', ')}\n`,
        )
        process.exit(1)
      }
      const { select } = await import('@clack/prompts')
      const result = await select({
        message: 'Select site:',
        options: sites.map(s => ({ value: s, label: s })),
      })
      if (typeof result === 'symbol') process.exit(0) // cancelled
      return join(sitesDir, result as string)
    }
  }

  // No site found — give a helpful error
  console.error(`\n  Error: no site found in current directory.\n`)
  console.error(`  To create a new project:  gazetta init my-site`)
  console.error(`  To use an existing site:  gazetta ${command} <path-to-site>\n`)
  process.exit(1)
}

/**
 * Resolve target from positional args or auto-detection.
 * Prompts if multiple targets and no explicit choice.
 */
export async function resolveTarget(
  positionalTarget: string | undefined,
  siteDir: string,
  command: string,
): Promise<string | undefined> {
  if (positionalTarget) return positionalTarget

  const manifest = await loadSiteManifestForCli(siteDir)
  if (!manifest) return undefined
  const targets = Object.keys(manifest.targets ?? {})

  if (targets.length <= 1) return targets[0] // auto-select if 0 or 1

  if (process.env.CI) {
    console.error(
      `\n  Error: multiple targets found. Specify one: gazetta ${command} <target>\n  Available: ${targets.join(', ')}\n`,
    )
    process.exit(1)
  }

  const { select } = await import('@clack/prompts')
  const result = await select({
    message: 'Select target:',
    options: targets.map(t => ({ value: t, label: t })),
  })
  if (typeof result === 'symbol') process.exit(0)
  return result as string
}
