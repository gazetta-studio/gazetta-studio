/**
 * What a page on a static target bakes in: every fragment its HTML
 * inlines (direct or nested, archived ones with the alias they render
 * as) and every asset the page or those fragments reference. Static
 * targets index these flattened edges so one listing of a fragment's
 * `fragment-deps` directory returns every page that bakes it
 * (sidecars.md "Target indices describe the target").
 *
 * Pure: walks the in-memory site, performs no I/O, and never throws on
 * missing or circular references (it records what it could resolve).
 */
import { aliasTarget } from './archive-helpers.js'
import { collectAssetRefs } from './assets/scan-manifest-for-asset.js'
import type { ResolvedLocales } from './locale.js'
import { lookupFragmentForLocale } from './resolver.js'
import { collectFragmentRefs } from './sidecars.js'
import type { Site } from './site-loader.js'
import type { ManifestLike } from './dep-sidecars.js'

export interface StaticPageDeps {
  fragments: Set<string>
  assets: Set<string>
}

type Walkable = Parameters<typeof collectAssetRefs>[0]

export function flattenStaticPageDeps(
  site: Site,
  page: ManifestLike,
  ctx: { locale?: string; resolvedLocales?: ResolvedLocales } = {},
): StaticPageDeps {
  const fragments = new Set<string>()
  const assets = new Set<string>()
  const lookupCtx = { site, locale: ctx.locale, resolvedLocales: ctx.resolvedLocales }

  const visitManifest = (manifest: ManifestLike): void => {
    for (const a of collectAssetRefs(manifest as unknown as Walkable)) assets.add(a)
    for (const ref of collectFragmentRefs(manifest.components as unknown[] | undefined)) visitFragment(ref)
  }

  const visitFragment = (name: string): void => {
    if (fragments.has(name)) return
    fragments.add(name)
    const manifest = lookupFragmentForLocale(name, lookupCtx)
    if (!manifest) return
    const alias = aliasTarget(manifest)
    if (alias) {
      visitFragment(alias)
      return
    }
    visitManifest(manifest)
  }

  visitManifest(page)
  return { fragments, assets }
}
