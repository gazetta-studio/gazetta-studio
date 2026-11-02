/**
 * One snapshot per publish (design-publish-undo.md Q4, cut 7, #1632): a
 * publish reads the source's manifests once. The server's gate, the
 * history record, the render loop and the manifest and asset-manifest
 * copies all read that one copy, so the target gets exactly what was
 * audited, and its HTML, manifests and revision agree. A save that lands
 * after the snapshot was taken goes out with the next publish.
 *
 * The snapshot is a storage view over the source: every page, fragment
 * and asset manifest, and the folder listings they came from, are read
 * once when it's created and served from memory afterwards, as raw text
 * (the site loader whitelists fields, so writing from the parsed form
 * would drop some). Manifests that weren't there at that moment stay
 * absent. Everything else (asset bytes, which are content-addressed,
 * templates, robots.txt, public/) reads the live source as before.
 */
import { manifestPath } from './assets/manifest.js'
import { collectAssetRefs } from './assets/scan-manifest-for-asset.js'
import { createContentRoot, type ContentRoot } from './content-root.js'
import { allFragmentEntries, allPageEntries, loadSite, type Site } from './site-loader.js'
import type { DirEntry, SiteManifest, StorageProvider } from './types.js'
import type { AdminCache } from './cache/types.js'

export interface PublishSnapshot {
  /** The site as loaded from the snapshot. */
  readonly site: Site
  /** The source as of the snapshot: read manifests through this. */
  readonly sourceRoot: ContentRoot
  /** The live source, for files the snapshot doesn't hold (asset bytes). */
  readonly liveRoot: ContentRoot
  /** Every asset any page or fragment manifest references. */
  readonly assets: ReadonlySet<string>
}

export interface CreatePublishSnapshotInput {
  readonly contentRoot: ContentRoot
  /** The site config; the loader refuses to load without one, as it always has. */
  readonly manifest: SiteManifest | undefined
  readonly templatesDir: string
  readonly cache?: AdminCache
}

export async function createPublishSnapshot(input: CreatePublishSnapshotInput): Promise<PublishSnapshot> {
  const { contentRoot } = input
  const frozen = freezeManifests(contentRoot.storage, contentRoot.rootPath)
  const sourceRoot = createContentRoot(frozen.storage, contentRoot.rootPath)
  // The loader reads every page and fragment manifest and lists their
  // folders, so loading through the view captures them.
  const site = await loadSite({
    contentRoot: sourceRoot,
    ...(input.manifest ? { manifest: input.manifest } : {}),
    templatesDir: input.templatesDir,
    ...(input.cache ? { cache: input.cache } : {}),
  })

  // Asset manifests: the default and every override slice of each asset
  // a manifest references, read from the raw text the loader captured.
  const assets = new Set<string>()
  const manifestDirs = [
    ...allPageEntries(site).map(e => ({ dir: e.page.dir, base: 'page', locale: e.locale })),
    ...allFragmentEntries(site).map(e => ({ dir: e.fragment.dir, base: 'fragment', locale: e.locale })),
  ]
  for (const { dir, base, locale } of manifestDirs) {
    const raw = frozen.captured(`${dir}/${base}${locale ? `.${locale}` : ''}.json`)
    if (raw === undefined) continue
    try {
      for (const name of collectAssetRefs(JSON.parse(raw))) assets.add(name)
    } catch {
      // An unparseable manifest was skipped by the loader too.
    }
  }
  // A missing default manifest is captured as absent, so the asset copy
  // still reports it missing on the source (design-media.md "Publish ref
  // integrity").
  const assetsRoot = sourceRoot.path('assets')
  for (const name of assets) {
    await frozen.storage.exists(`${assetsRoot}/${manifestPath(name)}`)
    const slash = name.lastIndexOf('/')
    const parent = slash >= 0 ? `${assetsRoot}/${name.slice(0, slash)}` : assetsRoot
    const leaf = slash >= 0 ? name.slice(slash + 1) : name
    const entries = await frozen.storage.readDir(parent).catch(() => [])
    for (const e of entries) {
      if (!e.isDirectory && e.name.startsWith(`${leaf}.asset.`) && e.name.endsWith('.json'))
        await frozen.storage.exists(`${parent}/${e.name}`)
    }
  }

  frozen.seal()
  return { site, sourceRoot, liveRoot: contentRoot, assets }
}

/** Page, fragment and asset manifests, by file name. */
const ITEM_MANIFEST = /^(page|fragment)(\.[^/]+)?\.json$/
const ASSET_MANIFEST = /\.asset(\.[^/]+)?\.json$/

function absentError(path: string): Error {
  return Object.assign(new Error(`ENOENT: not in the publish snapshot: ${path}`), { code: 'ENOENT' })
}

/**
 * A storage that serves manifests and their folder listings from what it
 * read before `seal()`. Other paths pass through to `inner`.
 */
function freezeManifests(inner: StorageProvider, rootPath: string) {
  const files = new Map<string, string | null>() // null: absent
  const dirs = new Map<string, DirEntry[]>()
  let sealed = false

  const relative = (path: string): string => {
    const p = path.replace(/^\.\//, '')
    if (!rootPath) return p
    return p === rootPath ? '' : p.startsWith(`${rootPath}/`) ? p.slice(rootPath.length + 1) : p
  }
  const area = (rel: string) => rel.split('/')[0]
  const isManifest = (path: string): boolean => {
    const rel = relative(path)
    const name = rel.slice(rel.lastIndexOf('/') + 1)
    const a = area(rel)
    if (a === 'pages' || a === 'fragments') return ITEM_MANIFEST.test(name)
    if (a === 'assets') return ASSET_MANIFEST.test(name)
    return false
  }
  const isListed = (path: string): boolean => ['pages', 'fragments', 'assets'].includes(area(relative(path)))

  const readManifest = async (path: string): Promise<string | null> => {
    const key = relative(path)
    if (files.has(key)) return files.get(key) ?? null
    if (sealed) return null
    const text = await inner.readFile(path).catch(() => null)
    files.set(key, text)
    return text
  }

  const storage = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'readFile') {
        return async (path: string) => {
          if (!isManifest(path)) return target.readFile(path)
          const text = await readManifest(path)
          if (text === null) throw absentError(path)
          return text
        }
      }
      if (prop === 'exists') {
        return async (path: string) => {
          if (isManifest(path)) return (await readManifest(path)) !== null
          const key = relative(path)
          if (sealed && dirs.has(key)) return true
          return target.exists(path)
        }
      }
      if (prop === 'readDir') {
        return async (path: string) => {
          if (!isListed(path)) return target.readDir(path)
          const key = relative(path)
          const listed = dirs.get(key)
          if (listed) return listed
          const entries = await target.readDir(path)
          // A folder first listed after the seal (an item's subfolder the
          // loader didn't walk) isn't frozen: it holds no manifest the
          // snapshot uses.
          if (!sealed) dirs.set(key, entries)
          return entries
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

  return {
    storage,
    /** The raw text captured at `path` (relative to the content root). */
    captured: (path: string) => files.get(relative(path)) ?? undefined,
    seal: () => {
      sealed = true
    },
  }
}
