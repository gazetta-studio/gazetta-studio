/**
 * Synthetic-site generator for performance benchmarks.
 *
 * Emits N pages with predictable but realistic content:
 *   - Each page references 0-3 assets via `_asset` (deterministic per index).
 *   - Each page references 0-1 fragments via `@fragment-name`.
 *   - Each page has 1-3 inline components.
 *   - Manifest size ≈ 600-1200 bytes (matches starter shape).
 *
 * Plus a small set of fragments + assets so refs resolve.
 *
 * Determinism: a fixed seed produces the same site every call. Bench
 * comparisons across runs see the same shape.
 */
import type { StorageProvider } from '../../src/types.js'

export interface SyntheticSiteOptions {
  /** How many pages to emit. Fragments + assets scale derived from this. */
  pageCount: number
  /** Where to root the content tree relative to the storage provider. */
  contentRoot: string
}

const ASSET_NAMES = ['hero', 'banner', 'logo', 'avatar', 'thumbnail']
const FRAGMENT_NAMES = ['header', 'footer', 'sidebar']

/**
 * Pseudo-random integer derived from a seed. Same i + range → same output.
 * We don't import a PRNG library — bench determinism only needs reproducibility.
 */
function pick(seed: number, range: number): number {
  // xorshift-ish; quality doesn't matter, only determinism
  let x = (seed * 2654435761) | 0
  x ^= x << 13
  x ^= x >>> 17
  x ^= x << 5
  return Math.abs(x) % range
}

function buildPageManifest(index: number) {
  const assetCount = pick(index, 4) // 0..3 assets per page
  const fragRef = pick(index + 7919, 100) < 60 ? `@${FRAGMENT_NAMES[pick(index, FRAGMENT_NAMES.length)]}` : null

  const components: unknown[] = []
  if (fragRef) components.push(fragRef)

  for (let c = 0; c < 1 + pick(index + 31, 3); c++) {
    const inlineAssets: Record<string, unknown> = {}
    for (let a = 0; a < assetCount; a++) {
      const assetName = ASSET_NAMES[pick(index * 7 + a, ASSET_NAMES.length)]
      inlineAssets[`asset${a}`] = { _asset: assetName }
    }
    components.push({
      name: `component-${c}`,
      template: 'card',
      content: {
        title: `Page ${index} component ${c}`,
        body: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
        ...inlineAssets,
      },
    })
  }

  return {
    template: 'page-default',
    route: `/page-${index}`,
    metadata: { title: `Page ${index}`, description: `Synthetic page #${index}` },
    components,
  }
}

function buildFragmentManifest(name: string) {
  return {
    template: 'fragment-default',
    components: [
      {
        name: `${name}-content`,
        template: 'card',
        content: { title: `Fragment ${name}`, _asset: 'logo' },
      },
    ],
  }
}

function buildAssetManifest(name: string) {
  return {
    version: 1,
    name,
    kind: 'embedded',
    source: 'internal',
    mime: 'image/jpeg',
    size: 12345,
    hash: 'a1b2c3d4',
    width: 800,
    height: 600,
    variants: [],
    alt: `${name} alt text`,
    uploadedAt: '2026-04-30T00:00:00.000Z',
    uploadedBy: '',
  }
}

/**
 * Materialize a synthetic site to the given storage provider. Awaits
 * every write. Caller is responsible for wiping the storage afterward.
 */
export async function buildSyntheticSite(storage: StorageProvider, opts: SyntheticSiteOptions): Promise<void> {
  const { pageCount, contentRoot } = opts
  const root = contentRoot ? `${contentRoot}/` : ''

  // Pages
  for (let i = 0; i < pageCount; i++) {
    const manifest = buildPageManifest(i)
    await storage.writeFile(`${root}pages/page-${i}/page.json`, `${JSON.stringify(manifest, null, 2)}\n`)
  }

  // Fragments
  for (const name of FRAGMENT_NAMES) {
    const manifest = buildFragmentManifest(name)
    await storage.writeFile(`${root}fragments/${name}/fragment.json`, `${JSON.stringify(manifest, null, 2)}\n`)
  }

  // Asset manifests (the bytes don't matter for refs benchmarks; the
  // manifest files exist so resolver code paths don't 404).
  for (const name of ASSET_NAMES) {
    const manifest = buildAssetManifest(name)
    await storage.writeFile(`${root}assets/${name}.asset.json`, `${JSON.stringify(manifest, null, 2)}\n`)
  }
}

/** Asset names that synthetic pages may reference, in deterministic order. */
export const SYNTHETIC_ASSETS = ASSET_NAMES
