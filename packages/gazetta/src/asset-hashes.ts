/**
 * Hashes of the assets a site's pages and fragments use, for the publish
 * hash (#1334, `sidecars.md` "Hash input"). Editing an asset (alt, focal
 * point, a language or theme version) changes its manifest files, so every
 * item that uses it changes hash and is republished.
 *
 * An asset's hash covers its default manifest and every override manifest
 * (`hero.asset.json`, `hero.asset.fr.json`, ...), names and bytes. The bytes
 * themselves are content-addressed by the manifests' `hash` fields, so the
 * manifests are enough. Only referenced assets are read: one directory
 * listing per folder that holds one, then one read per manifest file.
 */
import { createHash } from 'node:crypto'
import { parseManifestFilename } from './assets/manifest-filename.js'
import { collectAssetRefs } from './assets/scan-manifest-for-asset.js'
import type { ContentRoot } from './content-root.js'
import type { Site } from './site-loader.js'

/** Reads in flight at once; keeps cloud sources from opening thousands of requests. */
const READ_CONCURRENCY = 32

type Walkable = Parameters<typeof collectAssetRefs>[0]

/** Every asset name a page or fragment of the site references, in any language. */
export function siteAssetRefs(site: Site): Set<string> {
  const names = fragmentAssetRefs(site)
  for (const page of site.pages.values()) addRefs(names, page)
  for (const entry of site.pageLocales.values()) for (const page of entry.locales.values()) addRefs(names, page)
  return names
}

/**
 * The asset names one item's hash can depend on: its own references and
 * every fragment's, since any fragment may be baked into it.
 */
export function itemAssetRefs(site: Site, item: Walkable): Set<string> {
  return addRefs(fragmentAssetRefs(site), item)
}

function fragmentAssetRefs(site: Site): Set<string> {
  const names = new Set<string>()
  for (const frag of site.fragments.values()) addRefs(names, frag)
  for (const entry of site.fragmentLocales.values()) for (const frag of entry.locales.values()) addRefs(names, frag)
  return names
}

function addRefs(names: Set<string>, manifest: Walkable): Set<string> {
  for (const name of collectAssetRefs(manifest)) names.add(name)
  return names
}

/**
 * Hash of each named asset's manifest files on `contentRoot`. An asset with
 * no manifest file has no entry, so it hashes as missing until it exists.
 */
export async function computeAssetHashes(
  contentRoot: ContentRoot,
  names: Iterable<string>,
): Promise<Map<string, string>> {
  const wanted = [...names]
  const byDir = new Map<string, Set<string>>()
  for (const name of wanted) {
    const slash = name.lastIndexOf('/')
    const dir = slash >= 0 ? name.slice(0, slash) : ''
    const set = byDir.get(dir) ?? new Set<string>()
    set.add(slash >= 0 ? name.slice(slash + 1) : name)
    byDir.set(dir, set)
  }

  // Manifest files per asset, sorted so the hash doesn't depend on listing order.
  const files = new Map<string, string[]>()
  await mapLimit([...byDir], READ_CONCURRENCY, async ([dir, leaves]) => {
    const dirPath = dir ? contentRoot.path('assets', dir) : contentRoot.path('assets')
    let entries: { name: string; isDirectory: boolean }[]
    try {
      entries = await contentRoot.storage.readDir(dirPath)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory) continue
      const parsed = parseManifestFilename(entry.name)
      if (!parsed || !leaves.has(parsed.assetName)) continue
      const name = dir ? `${dir}/${parsed.assetName}` : parsed.assetName
      const list = files.get(name) ?? []
      list.push(dir ? `${dir}/${entry.name}` : entry.name)
      files.set(name, list)
    }
  })

  const reads = [...files].flatMap(([name, paths]) => paths.map(path => ({ name, path })))
  const contents = new Map<string, string>()
  await mapLimit(reads, READ_CONCURRENCY, async ({ path }) => {
    const raw = await contentRoot.storage.readFile(contentRoot.path('assets', path)).catch(() => null)
    if (raw !== null) contents.set(path, raw)
  })

  const hashes = new Map<string, string>()
  for (const [name, paths] of files) {
    const h = createHash('md5')
    let any = false
    for (const path of [...paths].sort()) {
      const raw = contents.get(path)
      if (raw === undefined) continue
      any = true
      h.update(path).update('\0').update(raw).update('\0')
    }
    if (any) hashes.set(name, h.digest('hex').slice(0, 8))
  }
  return hashes
}

/** The asset hashes for every asset `site` references, read from the site's own content root. */
export function siteAssetHashes(site: Site): Promise<Map<string, string>> {
  return computeAssetHashes(site.contentRoot, siteAssetRefs(site))
}

async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) await fn(items[next++])
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}
