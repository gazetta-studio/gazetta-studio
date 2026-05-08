/**
 * Integration tests for the altRequired validator.
 *
 * Uses real on-disk template fixtures under `tests/fixtures/templates-altreq/`
 * so the toJSONSchema path is exercised end-to-end. Asset manifests are
 * stubbed via memoryStorage.
 */
import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type { PageManifest, StorageProvider } from '../src/types.js'
import type { Site } from '../src/site-loader.js'
import { altRequired } from '../src/validation/validators/alt-required.js'

const here = dirname(fileURLToPath(import.meta.url))
const templatesDir = resolve(here, 'fixtures/templates-altreq')

function memoryStorage(initial: Record<string, string> = {}): StorageProvider {
  const files = new Map(Object.entries(initial))
  return {
    async readFile(path) {
      const v = files.get(path)
      if (v === undefined) throw new Error(`ENOENT: ${path}`)
      return v
    },
    async writeFile(path, content) {
      files.set(path, content as string)
    },
    async readDir() {
      return []
    },
    async exists(path) {
      return files.has(path)
    },
    async mkdir() {},
    async rm(path) {
      files.delete(path)
    },
    async readBytes() {
      throw new Error('not used in test')
    },
    async writeBytes() {},
    async readStream() {
      throw new Error('not used in test')
    },
    async writeStream() {
      throw new Error('not used in test')
    },
  }
}

function buildSite(): Site {
  return {
    pages: new Map(),
    fragments: new Map(),
    pageLocales: new Map(),
    fragmentLocales: new Map(),
    manifest: { name: 'test', targets: { local: {} } } as Site['manifest'],
    templatesDir,
  } as Site
}

const heroPage: PageManifest = {
  template: 'hero',
  content: { image: { _asset: 'sunset' } }, // no per-ref alt
}

const baseInput = (page: PageManifest, storage: StorageProvider) => ({
  stage: 'save-delta' as const,
  site: buildSite(),
  contentRoot: { rootPath: '', join: () => '' } as never,
  storage,
  scope: {
    kind: 'save-delta' as const,
    item: { kind: 'page' as const, name: 'home', itemPath: 'pages/home/page.json' },
    before: null,
    after: page,
  },
})

describe('altRequired validator', () => {
  it('errors when altRequired field has no per-ref alt and no asset alt', async () => {
    const storage = memoryStorage({
      'assets/sunset.asset.json': JSON.stringify({ name: 'sunset', kind: 'embedded', alt: null }),
    })
    const issues = await altRequired.validate(baseInput(heroPage, storage))
    expect(issues).toHaveLength(1)
    expect(issues[0].validator).toBe('altRequired')
    expect(issues[0].severity).toBe('error')
    expect(issues[0].contentPath).toBe('image')
    expect(issues[0].message).toContain('sunset')
  })

  it('passes when per-reference alt is set', async () => {
    const storage = memoryStorage({
      'assets/sunset.asset.json': JSON.stringify({ name: 'sunset', kind: 'embedded', alt: null }),
    })
    const page: PageManifest = {
      template: 'hero',
      content: { image: { _asset: 'sunset', alt: 'a fiery sunset' } },
    }
    const issues = await altRequired.validate(baseInput(page, storage))
    expect(issues).toEqual([])
  })

  it('passes when asset default alt is set', async () => {
    const storage = memoryStorage({
      'assets/sunset.asset.json': JSON.stringify({ name: 'sunset', kind: 'embedded', alt: 'sunset (default)' }),
    })
    const issues = await altRequired.validate(baseInput(heroPage, storage))
    expect(issues).toEqual([])
  })

  it('passes when per-reference alt is empty string (decorative)', async () => {
    const storage = memoryStorage({
      'assets/sunset.asset.json': JSON.stringify({ name: 'sunset', kind: 'embedded', alt: null }),
    })
    const page: PageManifest = {
      template: 'hero',
      content: { image: { _asset: 'sunset', alt: '' } },
    }
    const issues = await altRequired.validate(baseInput(page, storage))
    expect(issues).toEqual([])
  })

  it('does not fire on banner template (no altRequired flag)', async () => {
    const storage = memoryStorage({
      'assets/sunset.asset.json': JSON.stringify({ name: 'sunset', kind: 'embedded', alt: null }),
    })
    const page: PageManifest = {
      template: 'banner',
      content: { image: { _asset: 'sunset' } },
    }
    const issues = await altRequired.validate(baseInput(page, storage))
    expect(issues).toEqual([])
  })

  it('does not fire when content.image is missing entirely', async () => {
    const storage = memoryStorage()
    const page: PageManifest = {
      template: 'hero',
      content: {}, // no image at all
    }
    const issues = await altRequired.validate(baseInput(page, storage))
    expect(issues).toEqual([])
  })
})
