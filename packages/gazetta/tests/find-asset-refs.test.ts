/**
 * Unit tests for `findAssetRefs`. Uses an in-memory StorageProvider so tests
 * aren't coupled to the filesystem — the find-refs logic cares about `readDir` +
 * `readFile` shapes, not disk primitives.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { findAssetRefs } from '../src/assets/find-refs.js'
import type { StorageProvider } from '../src/types.js'

interface MemFile {
  content: string
}

function createMemoryStorage(initial: Record<string, string> = {}): StorageProvider {
  const files = new Map<string, MemFile>()
  for (const [path, content] of Object.entries(initial)) {
    files.set(path, { content })
  }

  const provider: StorageProvider = {
    async readFile(path) {
      const f = files.get(path)
      if (!f) throw new Error(`ENOENT: ${path}`)
      return f.content
    },
    async writeFile(path, content) {
      files.set(path, { content })
    },
    async exists(path) {
      if (files.has(path)) return true
      // Directory: any file with this prefix exists
      const prefix = path.endsWith('/') ? path : path + '/'
      for (const p of files.keys()) {
        if (p.startsWith(prefix)) return true
      }
      return false
    },
    async readDir(path) {
      const prefix = path === '' ? '' : path.endsWith('/') ? path : path + '/'
      const seen = new Map<string, boolean>()
      let found = false
      for (const p of files.keys()) {
        if (!p.startsWith(prefix)) continue
        found = true
        const rest = p.slice(prefix.length)
        const slashIdx = rest.indexOf('/')
        if (slashIdx === -1) {
          seen.set(rest, false)
        } else {
          seen.set(rest.slice(0, slashIdx), true)
        }
      }
      if (!found && prefix !== '') throw new Error(`ENOENT: ${path}`)
      return [...seen.entries()].map(([name, isDirectory]) => ({ name, isDirectory }))
    },
    async mkdir() {
      /* no-op: paths auto-create */
    },
    async rm(path) {
      files.delete(path)
      const prefix = path.endsWith('/') ? path : path + '/'
      for (const p of [...files.keys()]) {
        if (p.startsWith(prefix)) files.delete(p)
      }
    },
  }
  return provider
}

function pageJson(template: string, extra: object = {}): string {
  return JSON.stringify({ template, route: '/whatever', ...extra }, null, 2)
}

function fragmentJson(template: string, extra: object = {}): string {
  return JSON.stringify({ template, ...extra }, null, 2)
}

describe('findAssetRefs', () => {
  let storage: StorageProvider

  beforeEach(() => {
    storage = createMemoryStorage({
      'site.yaml': 'name: test-site\n',
    })
  })

  it('returns empty when no pages or fragments reference the asset', async () => {
    await storage.writeFile('pages/home/page.json', pageJson('hero', { content: { title: 'Home' } }))
    const refs = await findAssetRefs({ storage, siteDir: '', assetName: 'hero' })
    expect(refs).toEqual([])
  })

  it('finds a top-level content ref in a page', async () => {
    await storage.writeFile(
      'pages/home/page.json',
      pageJson('page-default', {
        content: { hero: { _asset: 'hero' } },
      }),
    )
    const refs = await findAssetRefs({ storage, siteDir: '', assetName: 'hero' })
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({
      source: 'page',
      path: 'pages/home/page.json',
      componentPath: 'hero',
    })
  })

  it('finds a ref inside a nested inline component', async () => {
    await storage.writeFile(
      'pages/home/page.json',
      pageJson('page-default', {
        content: {},
        components: [{ name: 'banner', template: 'banner', content: { image: { _asset: 'hero' } } }],
      }),
    )
    const refs = await findAssetRefs({ storage, siteDir: '', assetName: 'hero' })
    expect(refs).toHaveLength(1)
    expect(refs[0].componentPath).toBe('banner.image')
  })

  it('finds refs inside arrays with index breadcrumbs', async () => {
    await storage.writeFile(
      'pages/home/page.json',
      pageJson('page-default', {
        content: {
          gallery: [{ photo: { _asset: 'hero' } }, { photo: { _asset: 'other' } }],
        },
      }),
    )
    const refs = await findAssetRefs({ storage, siteDir: '', assetName: 'hero' })
    expect(refs).toHaveLength(1)
    expect(refs[0].componentPath).toBe('gallery[0].photo')
  })

  it('ignores fragment-reference strings (@-prefixed entries)', async () => {
    await storage.writeFile(
      'pages/home/page.json',
      pageJson('page-default', {
        content: {},
        components: ['@header', { name: 'inline', template: 't', content: { img: { _asset: 'hero' } } }],
      }),
    )
    await storage.writeFile('fragments/header/fragment.json', fragmentJson('header-layout'))
    const refs = await findAssetRefs({ storage, siteDir: '', assetName: 'hero' })
    expect(refs).toHaveLength(1)
    expect(refs[0].componentPath).toBe('inline.img')
  })

  it('finds refs across multiple manifests (pages and fragments)', async () => {
    await storage.writeFile('pages/home/page.json', pageJson('page-default', { content: { hero: { _asset: 'hero' } } }))
    await storage.writeFile(
      'fragments/promo/fragment.json',
      fragmentJson('promo', { content: { image: { _asset: 'hero' } } }),
    )
    const refs = await findAssetRefs({ storage, siteDir: '', assetName: 'hero' })
    expect(refs).toHaveLength(2)
    expect(refs.map(r => r.source).sort()).toEqual(['fragment', 'page'])
  })

  it('finds multiple refs to the same asset in one manifest', async () => {
    await storage.writeFile(
      'pages/home/page.json',
      pageJson('page-default', {
        content: {
          hero: { _asset: 'hero' },
          secondary: { _asset: 'hero' },
        },
      }),
    )
    const refs = await findAssetRefs({ storage, siteDir: '', assetName: 'hero' })
    expect(refs).toHaveLength(2)
    expect(refs.map(r => r.componentPath).sort()).toEqual(['hero', 'secondary'])
  })

  it('ignores values where _asset is non-string (e.g. numeric)', async () => {
    await storage.writeFile(
      'pages/home/page.json',
      pageJson('page-default', {
        content: {
          glitch: { _asset: 42 },
          real: { _asset: 'hero' },
        },
      }),
    )
    const refs = await findAssetRefs({ storage, siteDir: '', assetName: 'hero' })
    expect(refs).toHaveLength(1)
    expect(refs[0].componentPath).toBe('real')
  })

  it('ignores refs to OTHER asset names', async () => {
    await storage.writeFile(
      'pages/home/page.json',
      pageJson('page-default', {
        content: { hero: { _asset: 'banner' } },
      }),
    )
    const refs = await findAssetRefs({ storage, siteDir: '', assetName: 'hero' })
    expect(refs).toEqual([])
  })

  it('returns empty when no pages or fragments exist at all', async () => {
    const refs = await findAssetRefs({ storage, siteDir: '', assetName: 'hero' })
    expect(refs).toEqual([])
  })
})
