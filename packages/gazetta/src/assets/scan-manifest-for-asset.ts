/**
 * Scan a single page/fragment manifest for references to a given asset.
 *
 * Single responsibility: pure recursive walk of one manifest's content +
 * nested inline components, emitting an `AssetRef` per match. No I/O,
 * no site-wide knowledge — this is the inner kernel.
 *
 * Two consumers:
 *   - `find-refs.ts` — loads the whole site and runs this walker over
 *     every page/fragment manifest (including locale variants)
 *   - future `.refs/` index writer — on every manifest save, runs this
 *     walker over the just-saved manifest to update the index incrementally
 *
 * Splitting the walker from the site loader lets both use the same
 * matching logic — the index writer can't call the site-wide scanner
 * for one-manifest updates (wrong granularity, wrong cost).
 *
 * Match shape:
 *   Any object value with a string-valued `_asset` property. The design
 *   reserves the `_` prefix for Gazetta-interpreted fields, so false
 *   positives require authors to violate the convention.
 */
import type { ComponentEntry, ComponentManifest } from '../types.js'
import type { AssetRef } from './refs.js'

export interface ScanManifestInput {
  /** The manifest being scanned (page or fragment). */
  readonly manifest: ComponentManifest
  /** Content-root-relative path of this manifest (for `AssetRef.path`). */
  readonly manifestPath: string
  /** Which `AssetRef.source` discriminator to tag matches with. */
  readonly source: 'page' | 'fragment'
  /** The asset name to look for. */
  readonly assetName: string
}

/**
 * Walk `input.manifest` and return every reference to `assetName`. One
 * entry per match — a manifest that references the asset twice (in two
 * different inline components, or twice in the same content blob)
 * produces two entries with different `componentPath` values.
 */
export function scanManifestForAsset(input: ScanManifestInput): AssetRef[] {
  const out: AssetRef[] = []
  walkComponent(input.manifest, '', input, out)
  return out
}

/** Walk a component manifest (page, fragment, or inline child). */
function walkComponent(
  comp: ComponentManifest | { content?: Record<string, unknown>; components?: ComponentEntry[]; name?: string },
  componentPath: string,
  input: ScanManifestInput,
  out: AssetRef[],
): void {
  if (comp.content) {
    scanValue(comp.content, componentPath, input, out)
  }
  // Fragment refs like "@header" don't carry content here — they're
  // scanned as their own manifests by the orchestrator.
  if (comp.components) {
    for (let i = 0; i < comp.components.length; i++) {
      const child = comp.components[i]
      if (typeof child === 'string') continue
      const childPath = componentPath ? `${componentPath}.${nameFor(child, i)}` : nameFor(child, i)
      walkComponent(child, childPath, input, out)
    }
  }
}

function nameFor(comp: { name?: string }, index: number): string {
  return comp.name ?? `[${index}]`
}

/**
 * Recursively walk a value looking for `{ _asset: "<assetName>", ... }`.
 * Matches only when `_asset` is a string equal to the target — avoids
 * false positives on numeric or unrelated keys.
 */
function scanValue(value: unknown, path: string, input: ScanManifestInput, out: AssetRef[]): void {
  if (value === null || typeof value !== 'object') return

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      scanValue(value[i], path ? `${path}[${i}]` : `[${i}]`, input, out)
    }
    return
  }

  const obj = value as Record<string, unknown>
  const assetField = obj._asset
  if (typeof assetField === 'string' && assetField === input.assetName) {
    out.push({
      source: input.source,
      path: input.manifestPath,
      componentPath: path || '<root>',
    })
    // Don't early-return — the asset ref object might itself contain
    // nested refs (a future template that composes embedded refs inside
    // an asset ref). Keep walking.
  }

  for (const [key, child] of Object.entries(obj)) {
    if (key === '_asset') continue
    scanValue(child, path ? `${path}.${key}` : key, input, out)
  }
}
