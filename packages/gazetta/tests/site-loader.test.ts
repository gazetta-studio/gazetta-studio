import { describe, it, expect, vi, afterEach } from 'vitest'
import { join, resolve } from 'node:path'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { deriveRoute } from '../src/site-loader.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { loadSite } from '../src/site-loader.js'
import { tempDir } from './_helpers/temp.js'

const testDir = tempDir('siteloader-test-' + Date.now())
const storage = createFilesystemProvider()

async function writeTestFile(path: string, content: string) {
  const full = join(testDir, path)
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, content)
}

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

describe('loadSite', () => {
  it('throws when neither manifest nor config is supplied', async () => {
    await mkdir(testDir, { recursive: true })
    await expect(loadSite({ siteDir: testDir, storage })).rejects.toThrow(
      'either `config` or `manifest` must be provided',
    )
  })

  it('loads a minimal site', async () => {
    await mkdir(join(testDir, 'pages'), { recursive: true })
    await mkdir(join(testDir, 'fragments'), { recursive: true })

    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const site = await loadSite({ siteDir: testDir, storage, manifest: { name: 'Test Site' } })
    expect(site.manifest.name).toBe('Test Site')
    expect(site.pages.size).toBe(0)
    expect(site.fragments.size).toBe(0)
    spy.mockRestore()
  })

  it('discovers pages', async () => {
    await writeTestFile('pages/home/page.json', JSON.stringify({ template: 'default' }))
    await writeTestFile('pages/about/page.json', JSON.stringify({ template: 'default' }))
    await mkdir(join(testDir, 'fragments'), { recursive: true })

    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const site = await loadSite({ siteDir: testDir, storage, manifest: { name: 'Test' } })
    expect(site.pages.size).toBe(2)
    expect(site.pages.has('home')).toBe(true)
    expect(site.pages.has('about')).toBe(true)
    expect(site.pages.get('home')!.route).toBe('/') // derived from folder name 'home'
    spy.mockRestore()
  })

  it('discovers nested pages', async () => {
    await writeTestFile('pages/blog/[slug]/page.json', JSON.stringify({ template: 'default' }))
    await mkdir(join(testDir, 'fragments'), { recursive: true })

    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const site = await loadSite({ siteDir: testDir, storage, manifest: { name: 'Test' } })
    expect(site.pages.has('blog/[slug]')).toBe(true)
    expect(site.pages.get('blog/[slug]')!.route).toBe('/blog/:slug')
    spy.mockRestore()
  })

  it('discovers fragments', async () => {
    await mkdir(join(testDir, 'pages'), { recursive: true })
    await writeTestFile('fragments/header/fragment.json', JSON.stringify({ template: 'header-layout' }))
    await writeTestFile('fragments/footer/fragment.json', JSON.stringify({ template: 'footer-layout' }))

    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const site = await loadSite({ siteDir: testDir, storage, manifest: { name: 'Test' } })
    expect(site.fragments.size).toBe(2)
    expect(site.fragments.has('header')).toBe(true)
    expect(site.fragments.has('footer')).toBe(true)
    spy.mockRestore()
  })

  it('sets dir on pages and fragments', async () => {
    await writeTestFile('pages/home/page.json', JSON.stringify({ template: 'default' }))
    await writeTestFile('fragments/header/fragment.json', JSON.stringify({ template: 'header-layout' }))

    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const site = await loadSite({ siteDir: testDir, storage, manifest: { name: 'Test' } })
    expect(site.pages.get('home')!.dir).toContain('pages/home')
    expect(site.fragments.get('header')!.dir).toContain('fragments/header')
    spy.mockRestore()
  })

  it('skips malformed page manifests', async () => {
    await writeTestFile('pages/good/page.json', JSON.stringify({ template: 'default' }))
    await writeTestFile('pages/bad/page.json', '{ invalid json }')
    await mkdir(join(testDir, 'fragments'), { recursive: true })

    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const site = await loadSite({ siteDir: testDir, storage, manifest: { name: 'Test' } })
    expect(site.pages.size).toBe(1)
    expect(site.pages.has('good')).toBe(true)
    spy.mockRestore()
  })

  it('warns when no pages found', async () => {
    await mkdir(join(testDir, 'pages'), { recursive: true })
    await mkdir(join(testDir, 'fragments'), { recursive: true })

    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await loadSite({ siteDir: testDir, storage, manifest: { name: 'Test' } })
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('no pages found'))
    spy.mockRestore()
  })

  it('loads the real starter site', async () => {
    const projectRoot = resolve(import.meta.dirname, '../../../examples/starter')
    const { starterManifest } = await import('./_helpers/starter.js')
    // Content lives inside the local target (post-transformation layout).
    const site = await loadSite({
      siteDir: resolve(projectRoot, 'sites/main/targets/local'),
      storage,
      templatesDir: resolve(projectRoot, 'templates'),
      manifest: await starterManifest(),
    })
    expect(site.manifest.name).toBe('Gazetta Starter')
    expect(site.pages.size).toBeGreaterThanOrEqual(3)
    expect(site.fragments.size).toBe(2)
  })
})

describe('loadSite — TS config', () => {
  it('accepts pre-loaded SiteConfig via the `config` option', async () => {
    await mkdir(testDir, { recursive: true })
    await mkdir(join(testDir, 'pages'), { recursive: true })
    await mkdir(join(testDir, 'fragments'), { recursive: true })

    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const site = await loadSite({
      siteDir: testDir,
      storage,
      config: { name: 'TS Site', locales: { default: 'en', supported: ['en'] } },
    })
    expect(site.manifest.name).toBe('TS Site')
    expect(site.manifest.locales?.default).toBe('en')
    spy.mockRestore()
  })

  it('rejects passing both manifest and config', async () => {
    await mkdir(testDir, { recursive: true })
    await expect(
      loadSite({
        siteDir: testDir,
        storage,
        manifest: { name: 'A' },
        config: { name: 'B' },
      }),
    ).rejects.toThrow('pass either `config` or `manifest`, not both')
  })
})

describe('deriveRoute', () => {
  it('home → /', () => {
    expect(deriveRoute('home')).toBe('/')
  })

  it('about → /about', () => {
    expect(deriveRoute('about')).toBe('/about')
  })

  it('blog/[slug] → /blog/:slug', () => {
    expect(deriveRoute('blog/[slug]')).toBe('/blog/:slug')
  })

  it('docs/getting-started → /docs/getting-started', () => {
    expect(deriveRoute('docs/getting-started')).toBe('/docs/getting-started')
  })

  it('products/[category]/[id] → /products/:category/:id', () => {
    expect(deriveRoute('products/[category]/[id]')).toBe('/products/:category/:id')
  })
})
