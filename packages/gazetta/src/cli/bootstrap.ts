/**
 * Shared bootstrap helpers for CLI commands and the dev server admin bootstrap.
 *
 * Responsibility: read site.yaml from the project site directory, build a
 * TargetRegistry from its targets, and derive a SourceContext pointing at
 * the default editable target. Callers compose these primitives; the admin
 * API and `createApp` runtime take over from there.
 */

import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import yaml from 'js-yaml'
import { createTargetRegistry, createTargetRegistryView } from '../targets.js'
import type { SiteManifest, TargetConfig, StorageProvider } from '../types.js'
import { createSourceContextFromRegistry, type SourceContext } from '../admin-api/source-context.js'
import type { TargetRegistry } from '../targets.js'

export interface BootstrapResult {
  /** Parsed site.yaml content. */
  manifest: SiteManifest
  /** Target configurations declared in site.yaml. */
  targetConfigs: Record<string, TargetConfig>
  /** Fully-initialized target registry (providers built, cloud targets connected). */
  registry: TargetRegistry
}

/**
 * Read site.yaml, initialize all targets, and return a TargetRegistry view.
 * Throws if site.yaml is missing or has no targets declared.
 */
export async function bootstrapFromSiteYaml(projectSiteDir: string): Promise<BootstrapResult> {
  const siteYamlPath = join(projectSiteDir, 'site.yaml')
  const manifest = yaml.load(readFileSync(siteYamlPath, 'utf-8')) as SiteManifest
  const targetConfigs = manifest.targets ?? {}

  if (Object.keys(targetConfigs).length === 0) {
    throw new Error(
      `No targets declared in ${siteYamlPath}. At least one target is required — ` +
        `add a local target:\n\ntargets:\n  local:\n    storage:\n      type: filesystem\n`,
    )
  }

  const providers = await createTargetRegistry(targetConfigs, projectSiteDir)
  const registry = createTargetRegistryView(providers, targetConfigs)
  return { manifest, targetConfigs, registry }
}

export interface BuildSourceContextOptions {
  projectSiteDir: string
  /** Pre-parsed manifest to avoid re-reading site.yaml when caller already has it. */
  manifest?: SiteManifest
  /** Explicit target name. Defaults to the registry's defaultEditable(). */
  targetName?: string
}

/**
 * High-level: read site.yaml, init only the chosen editable target, return a
 * SourceContext and metadata. Cloud/remote targets are not initialized —
 * callers that need them (publish, fetch, compare) init on demand.
 *
 * Rationale: validate and dev-bootstrap only need the source (editable local)
 * target; initializing cloud targets upfront adds seconds of latency and
 * surfaces spurious failures when credentials aren't configured.
 */
export async function buildSourceContext(opts: BuildSourceContextOptions): Promise<{
  source: SourceContext
  manifest: SiteManifest
  targetConfigs: Record<string, TargetConfig>
}> {
  const siteYamlPath = join(opts.projectSiteDir, 'site.yaml')
  const manifest = opts.manifest ?? (yaml.load(readFileSync(siteYamlPath, 'utf-8')) as SiteManifest)
  const targetConfigs = manifest.targets ?? {}
  if (Object.keys(targetConfigs).length === 0) {
    throw new Error(
      `No targets declared in ${siteYamlPath}. At least one target is required — ` +
        `add a local target:\n\ntargets:\n  local:\n    storage:\n      type: filesystem\n`,
    )
  }

  // Pick the editable target (explicit override or first editable in declaration order).
  const { isEditable } = await import('../types.js')
  const editableNames = Object.entries(targetConfigs)
    .filter(([, cfg]) => isEditable(cfg))
    .map(([n]) => n)
  if (editableNames.length === 0) {
    throw new Error(
      `No editable target in ${siteYamlPath}. Add one:\n\n` +
        `targets:\n  local:\n    storage:\n      type: filesystem\n`,
    )
  }
  const targetName = opts.targetName ?? editableNames[0]
  const config = targetConfigs[targetName]
  if (!config) {
    const { UnknownTargetError } = await import('../targets.js')
    throw new UnknownTargetError(targetName)
  }
  if (!isEditable(config)) {
    throw new Error(`Target "${targetName}" is not editable`)
  }

  // Init only the chosen target's provider.
  const { createStorageProvider } = await import('../targets.js')
  const storage = await createStorageProvider(config.storage, opts.projectSiteDir, targetName)
  const initProvider = storage as StorageProvider & { init?: () => Promise<void> }
  if (typeof initProvider.init === 'function') {
    await initProvider.init()
  }

  // Build a single-target view; callers that need cross-target access call
  // bootstrapFromSiteYaml() instead (or use admin-api's lazy target init).
  const singleTargetProviders = new Map<string, StorageProvider>([[targetName, storage]])
  const registry = createTargetRegistryView(singleTargetProviders, targetConfigs)

  const source = createSourceContextFromRegistry({
    registry,
    targetName,
    projectSiteDir: opts.projectSiteDir,
    manifest,
  })

  return { source, manifest, targetConfigs }
}
