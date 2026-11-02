/**
 * Before a publish records history or copies manifests, check that every
 * asset its snapshot's items use still has its files on the source
 * (design-publish-undo.md Q4, #1632). Replacing, renaming or deleting an
 * asset during a publish removes them; the items that use such an asset
 * aren't published this time, and everything else goes ahead.
 */
import { assetBytePaths, enumerateAssetStoragePaths } from './assets/asset-paths.js'
import { readDefaultManifest } from './assets/manifest-default.js'
import { collectAssetRefs } from './assets/scan-manifest-for-asset.js'
import { mapLimit } from './concurrency.js'
import type { PublishSnapshot } from './publish-snapshot.js'
import type { Site } from './site-loader.js'
import type { ComponentEntry, FragmentManifest, PageManifest } from './types.js'

export interface ItemName {
  readonly kind: 'page' | 'fragment'
  readonly name: string
}

export interface NotPublished extends ItemName {
  /** The assets found gone that this item uses. */
  readonly assets: readonly string[]
}

export interface GoneAssetCheck {
  /** Assets whose files were removed after the snapshot was taken. */
  readonly gone: ReadonlySet<string>
  /** Items that use one of them, in any language. */
  readonly notPublished: readonly NotPublished[]
}

/**
 * `bakesFragments`: on a static target a page bakes its fragments in,
 * so a page whose fragment uses a gone asset isn't published either.
 */
export async function checkGoneAssets(
  snapshot: PublishSnapshot,
  items: readonly ItemName[],
  bakesFragments: boolean,
): Promise<GoneAssetCheck> {
  const usedBy = new Map<string, Set<string>>()
  for (const item of items) {
    const key = `${item.kind}:${item.name}`
    if (usedBy.has(key)) continue
    const names = new Set<string>()
    for (const m of versionsOf(snapshot.site, item)) for (const a of collectAssetRefs(m)) names.add(a)
    if (bakesFragments && item.kind === 'page') {
      for (const frag of fragmentsBakedInto(snapshot.site, item.name))
        for (const m of versionsOf(snapshot.site, { kind: 'fragment', name: frag }))
          for (const a of collectAssetRefs(m)) names.add(a)
    }
    usedBy.set(key, names)
  }

  const assetsRoot = snapshot.sourceRoot.path('assets')
  const candidates = [...new Set([...usedBy.values()].flatMap(s => [...s]))]
  const goneFlags = await mapLimit(candidates, async name => {
    let manifest: Awaited<ReturnType<typeof readDefaultManifest>>
    try {
      manifest = await readDefaultManifest(snapshot.sourceRoot.storage, assetsRoot, name)
    } catch {
      // No manifest in the snapshot: the asset copy reports it missing.
      return false
    }
    const paths = await enumerateAssetStoragePaths(snapshot.sourceRoot.storage, assetsRoot, manifest)
    for (const path of assetBytePaths(paths)) {
      if (!(await snapshot.liveRoot.storage.exists(path))) return true
    }
    return false
  })
  const gone = new Set(candidates.filter((_, i) => goneFlags[i]))

  const notPublished: NotPublished[] = []
  if (gone.size > 0) {
    for (const [key, names] of usedBy) {
      const hit = [...names].filter(a => gone.has(a)).sort()
      if (hit.length === 0) continue
      const [kind, name] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
      notPublished.push({ kind: kind as ItemName['kind'], name, assets: hit })
    }
  }
  return { gone, notPublished }
}

/** The item's default manifest and every language version, as the snapshot loaded them. */
function versionsOf(site: Site, item: ItemName): (PageManifest | FragmentManifest)[] {
  const main = item.kind === 'page' ? site.pages.get(item.name) : site.fragments.get(item.name)
  const locales =
    item.kind === 'page' ? site.pageLocales.get(item.name)?.locales : site.fragmentLocales.get(item.name)?.locales
  return [...(main ? [main] : []), ...(locales ? [...locales.values()] : [])]
}

/** Fragments a page uses, directly or through other fragments, in any language. */
function fragmentsBakedInto(site: Site, pageName: string): Set<string> {
  const found = new Set<string>()
  const walk = (entries: readonly ComponentEntry[]) => {
    for (const entry of entries) {
      if (typeof entry === 'string') {
        if (!entry.startsWith('@')) continue
        const name = entry.slice(1)
        if (found.has(name)) continue
        found.add(name)
        for (const m of versionsOf(site, { kind: 'fragment', name })) walk(m.components ?? [])
      } else if (entry.components) {
        walk(entry.components)
      }
    }
  }
  for (const m of versionsOf(site, { kind: 'page', name: pageName })) walk(m.components ?? [])
  return found
}
