/**
 * Find asset references across a site's pages and fragments.
 *
 * Walks every page/fragment manifest (including locale variants and nested
 * inline components) looking for values shaped `{ _asset: "<name>", ... }`.
 * Returns the structural location of each match so the admin's usage panel
 * can render "page/home → hero" breadcrumbs.
 *
 * Single responsibility: scan + match. No deletion logic, no HTTP concerns,
 * no UI shaping — just "given a site, find the refs."
 *
 * Scan-on-demand model (v1 simplification):
 * - The design doc calls for an incremental `.refs/` index written on every
 *   save. That's a separate feature — wiring into pages.ts / fragments.ts
 *   save paths, recording sidecar revisions, providing a reindex command.
 * - For v1, delete-check and usage-panel reads do a fresh scan. O(content
 *   size) per call, fine up to a few thousand pages. Upgrade to the index
 *   when scale demands it.
 *
 * Ref shape:
 *   Matches any object with a string-valued `_asset` property. The design
 *   reserves the `_` prefix for Gazetta-interpreted fields, so a false
 *   positive requires template authors to violate that rule. Non-string
 *   `_asset` values (e.g. `{_asset: 42}`) are ignored — those can't be
 *   real asset refs.
 */
import type { ComponentEntry, ComponentManifest, StorageProvider } from '../types.js'
import type { AssetRef } from './errors.js'
import { loadSite, allPageEntries, allFragmentEntries } from '../site-loader.js'
import { createContentRoot } from '../content-root.js'

export interface FindRefsInput {
  storage: StorageProvider
  /** Path prefix applied to storage operations (content root). */
  siteDir: string
  /** The asset name to find references to. */
  assetName: string
  /**
   * Optional project-level site manifest. Passed through to `loadSite` so
   * scans work in contexts where the target doesn't have its own site.yaml.
   */
  manifest?: import('../types.js').SiteManifest
}

/**
 * Find every page or fragment manifest that references `assetName`. One
 * entry per match — a manifest that references the asset twice (e.g. in
 * two different inline components) produces two entries with different
 * `componentPath` values.
 */
export async function findAssetRefs(input: FindRefsInput): Promise<AssetRef[]> {
  const contentRoot = createContentRoot(input.storage, input.siteDir)
  const site = await loadSite({ contentRoot, manifest: input.manifest })

  const refs: AssetRef[] = []

  for (const { name, page, locale } of allPageEntries(site)) {
    const manifestPath = localeManifestPath('pages', name, 'page', locale)
    walkManifest(page, manifestPath, 'page', input.assetName, refs)
  }

  for (const { name, fragment, locale } of allFragmentEntries(site)) {
    const manifestPath = localeManifestPath('fragments', name, 'fragment', locale)
    walkManifest(fragment, manifestPath, 'fragment', input.assetName, refs)
  }

  return refs
}

function localeManifestPath(
  root: 'pages' | 'fragments',
  itemName: string,
  baseName: 'page' | 'fragment',
  locale: string | undefined,
): string {
  const file = locale ? `${baseName}.${locale}.json` : `${baseName}.json`
  return `${root}/${itemName}/${file}`
}

/** Walk a single manifest's content + components tree, appending matches to `out`. */
function walkManifest(
  manifest: ComponentManifest,
  manifestPath: string,
  source: 'page' | 'fragment',
  assetName: string,
  out: AssetRef[],
): void {
  // Root-level content.
  if (manifest.content) {
    scanValue(manifest.content, '', assetName, manifestPath, source, out)
  }
  // Nested inline components (fragment refs like "@header" don't carry
  // content here — they're scanned as their own manifests).
  if (manifest.components) {
    for (let i = 0; i < manifest.components.length; i++) {
      const entry = manifest.components[i]
      if (typeof entry === 'string') continue
      walkInlineComponent(entry, makeComponentPath(entry, i), assetName, manifestPath, source, out)
    }
  }
}

function walkInlineComponent(
  comp: { name?: string; content?: Record<string, unknown>; components?: ComponentEntry[] },
  componentPath: string,
  assetName: string,
  manifestPath: string,
  source: 'page' | 'fragment',
  out: AssetRef[],
): void {
  if (comp.content) scanValue(comp.content, componentPath, assetName, manifestPath, source, out)
  if (comp.components) {
    for (let i = 0; i < comp.components.length; i++) {
      const child = comp.components[i]
      if (typeof child === 'string') continue
      walkInlineComponent(
        child,
        `${componentPath}.${makeComponentPath(child, i)}`,
        assetName,
        manifestPath,
        source,
        out,
      )
    }
  }
}

function makeComponentPath(comp: { name?: string }, index: number): string {
  return comp.name ?? `[${index}]`
}

/**
 * Recursively walk a value looking for `{ _asset: "<assetName>", ... }`.
 * Matches only when the value is an object and `_asset` is a string equal
 * to the target name — avoids false positives on numeric or unrelated keys.
 */
function scanValue(
  value: unknown,
  path: string,
  assetName: string,
  manifestPath: string,
  source: 'page' | 'fragment',
  out: AssetRef[],
): void {
  if (value === null || typeof value !== 'object') return

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      scanValue(value[i], path ? `${path}[${i}]` : `[${i}]`, assetName, manifestPath, source, out)
    }
    return
  }

  const obj = value as Record<string, unknown>
  const assetField = obj._asset
  if (typeof assetField === 'string' && assetField === assetName) {
    out.push({ source, path: manifestPath, componentPath: path || '<root>' })
    // Don't early-return — the asset ref object might contain nested refs
    // (e.g. a template that composes embedded refs). Keep walking.
  }

  for (const [key, child] of Object.entries(obj)) {
    if (key === '_asset') continue
    scanValue(child, path ? `${path}.${key}` : key, assetName, manifestPath, source, out)
  }
}
