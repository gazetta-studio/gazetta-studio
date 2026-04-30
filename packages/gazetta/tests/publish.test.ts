import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { join, resolve } from 'node:path'
import { writeFile, mkdir, rm, readdir } from 'node:fs/promises'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { publishItems, resolveDependencies } from '../src/publish.js'
import { publishPageRendered, publishPageStatic, publishFragmentRendered } from '../src/publish-rendered.js'
import { createContentRoot } from '../src/content-root.js'
import { loadSite, type Site } from '../src/site-loader.js'
import { tempDir } from './_helpers/temp.js'
import { starterManifest, starterTargetDir, starterTemplatesDir } from './_helpers/starter.js'

const testDir = tempDir('publish-test-' + Date.now())
const sourceDir = join(testDir, 'source')
const targetDir = join(testDir, 'target')

async function writeTestFile(base: string, path: string, content: string) {
  const full = join(base, path)
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, content)
}

beforeEach(async () => {
  await mkdir(sourceDir, { recursive: true })
  await mkdir(targetDir, { recursive: true })
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

describe('publishItems', () => {
  it('copies a single page directory', async () => {
    await writeTestFile(sourceDir, 'pages/home/page.json', JSON.stringify({ template: 'default' }))
    await writeTestFile(sourceDir, 'site.yaml', 'name: Test')

    const source = createFilesystemProvider(sourceDir)
    const target = createFilesystemProvider(targetDir)

    const { copiedFiles } = await publishItems(createContentRoot(source), createContentRoot(target), ['pages/home'])
    expect(copiedFiles).toBeGreaterThanOrEqual(2) // page.json + site.yaml
    expect(await target.exists('pages/home/page.json')).toBe(true)
    expect(await target.exists('site.yaml')).toBe(true)
  })

  it('copies multiple items', async () => {
    await writeTestFile(sourceDir, 'pages/home/page.json', JSON.stringify({ template: 'default' }))
    await writeTestFile(sourceDir, 'fragments/header/fragment.json', JSON.stringify({ template: 'header' }))
    await writeTestFile(sourceDir, 'site.yaml', 'name: Test')

    const source = createFilesystemProvider(sourceDir)
    const target = createFilesystemProvider(targetDir)

    const { copiedFiles } = await publishItems(createContentRoot(source), createContentRoot(target), [
      'pages/home',
      'fragments/header',
    ])
    expect(copiedFiles).toBeGreaterThanOrEqual(3)
    expect(await target.exists('pages/home/page.json')).toBe(true)
    expect(await target.exists('fragments/header/fragment.json')).toBe(true)
  })

  it('copies nested directory structure', async () => {
    await writeTestFile(sourceDir, 'pages/blog/[slug]/page.json', JSON.stringify({ template: 'article' }))
    await writeTestFile(sourceDir, 'site.yaml', 'name: Test')

    const source = createFilesystemProvider(sourceDir)
    const target = createFilesystemProvider(targetDir)

    const { copiedFiles } = await publishItems(createContentRoot(source), createContentRoot(target), [
      'pages/blog/[slug]',
    ])
    expect(copiedFiles).toBeGreaterThanOrEqual(2)
    expect(await target.exists('pages/blog/[slug]/page.json')).toBe(true)
  })

  it('preserves file content', async () => {
    const content = JSON.stringify({ template: 'page-default', metadata: { title: 'Home' } })
    await writeTestFile(sourceDir, 'pages/home/page.json', content)
    await writeTestFile(sourceDir, 'site.yaml', 'name: Test')

    const source = createFilesystemProvider(sourceDir)
    const target = createFilesystemProvider(targetDir)

    await publishItems(createContentRoot(source), createContentRoot(target), ['pages/home'])
    const copied = await target.readFile('pages/home/page.json')
    expect(copied).toBe(content)
  })

  it('handles missing site.yaml gracefully', async () => {
    await writeTestFile(sourceDir, 'pages/home/page.json', JSON.stringify({ template: 'default' }))

    const source = createFilesystemProvider(sourceDir)
    const target = createFilesystemProvider(targetDir)

    const { copiedFiles } = await publishItems(createContentRoot(source), createContentRoot(target), ['pages/home'])
    expect(copiedFiles).toBe(1) // only page.json, no site.yaml
  })

  it('returns 0 for nonexistent items', async () => {
    await writeTestFile(sourceDir, 'site.yaml', 'name: Test')

    const source = createFilesystemProvider(sourceDir)
    const target = createFilesystemProvider(targetDir)

    const { copiedFiles } = await publishItems(createContentRoot(source), createContentRoot(target), [
      'pages/nonexistent',
    ])
    expect(copiedFiles).toBe(1) // only site.yaml
  })

  it('accepts ContentRoot inputs (preferred shape)', async () => {
    await writeTestFile(sourceDir, 'pages/home/page.json', JSON.stringify({ template: 'default' }))
    await writeTestFile(sourceDir, 'site.yaml', 'name: Test')

    const source = createFilesystemProvider(sourceDir)
    const target = createFilesystemProvider(targetDir)

    const sourceRoot = createContentRoot(source)
    const targetRoot = createContentRoot(target)

    const { copiedFiles } = await publishItems(sourceRoot, targetRoot, ['pages/home'])
    expect(copiedFiles).toBeGreaterThanOrEqual(2)
    expect(await target.exists('pages/home/page.json')).toBe(true)
    expect(await target.exists('site.yaml')).toBe(true)
  })
})

describe('resolveDependencies', () => {
  it('includes the item itself', async () => {
    await writeTestFile(sourceDir, 'pages/home/page.json', JSON.stringify({ template: 'default' }))

    const storage = createFilesystemProvider(sourceDir)
    const deps = await resolveDependencies(createContentRoot(storage), ['pages/home'])
    expect(deps).toContain('pages/home')
  })

  it('accepts ContentRoot input (preferred shape)', async () => {
    await writeTestFile(
      sourceDir,
      'pages/home/page.json',
      JSON.stringify({
        template: 'default',
        components: ['@header', { name: 'hero', template: 'hero' }],
      }),
    )

    const storage = createFilesystemProvider(sourceDir)

    const root = createContentRoot(storage)

    const deps = await resolveDependencies(root, ['pages/home'])
    expect(deps).toContain('pages/home')
    expect(deps).toContain('fragments/header')
    expect(deps).toContain('templates/hero')
  })

  it('resolves template dependency', async () => {
    await writeTestFile(sourceDir, 'pages/home/page.json', JSON.stringify({ template: 'page-default' }))

    const storage = createFilesystemProvider(sourceDir)
    const deps = await resolveDependencies(createContentRoot(storage), ['pages/home'])
    expect(deps).toContain('templates/page-default')
  })

  it('resolves fragment dependencies', async () => {
    await writeTestFile(
      sourceDir,
      'pages/home/page.json',
      JSON.stringify({
        template: 'default',
        components: ['@header', { name: 'hero', template: 'hero' }],
      }),
    )

    const storage = createFilesystemProvider(sourceDir)
    const deps = await resolveDependencies(createContentRoot(storage), ['pages/home'])
    expect(deps).toContain('fragments/header')
    expect(deps).toContain('templates/hero')
  })

  it('resolves nested fragment dependencies', async () => {
    await writeTestFile(
      sourceDir,
      'pages/home/page.json',
      JSON.stringify({
        template: 'default',
        components: ['@header'],
      }),
    )
    await writeTestFile(
      sourceDir,
      'fragments/header/fragment.json',
      JSON.stringify({
        template: 'header-layout',
        components: [
          { name: 'logo', template: 'logo' },
          { name: 'nav', template: 'nav' },
        ],
      }),
    )

    const storage = createFilesystemProvider(sourceDir)
    const deps = await resolveDependencies(createContentRoot(storage), ['pages/home'])
    expect(deps).toContain('fragments/header')
    expect(deps).toContain('templates/header-layout')
    expect(deps).toContain('templates/logo')
    expect(deps).toContain('templates/nav')
  })

  it('deduplicates dependencies', async () => {
    await writeTestFile(
      sourceDir,
      'pages/home/page.json',
      JSON.stringify({ template: 'default', components: ['@header', '@footer'] }),
    )
    await writeTestFile(
      sourceDir,
      'pages/about/page.json',
      JSON.stringify({ template: 'default', components: ['@header', '@footer'] }),
    )

    const storage = createFilesystemProvider(sourceDir)
    const deps = await resolveDependencies(createContentRoot(storage), ['pages/home', 'pages/about'])
    const templateCount = deps.filter(d => d === 'templates/default').length
    expect(templateCount).toBe(1) // not duplicated
  })

  it('handles items without manifests', async () => {
    await mkdir(join(sourceDir, 'pages/empty'), { recursive: true })

    const storage = createFilesystemProvider(sourceDir)
    const deps = await resolveDependencies(createContentRoot(storage), ['pages/empty'])
    expect(deps).toContain('pages/empty')
    expect(deps).toHaveLength(1)
  })
})

describe('publishRendered', () => {
  const starterDir = starterTargetDir
  const templatesDir = starterTemplatesDir
  const storage = createFilesystemProvider()
  const renderTargetDir = tempDir('render-test-' + Date.now())
  let site: Site

  beforeAll(async () => {
    const manifest = await starterManifest()
    site = await loadSite({ siteDir: starterDir, storage, templatesDir, manifest })
  })

  afterEach(async () => {
    await rm(renderTargetDir, { recursive: true, force: true })
  })

  it('publishes a page as HTML with ESI placeholders and hashed CSS', async () => {
    const target = createFilesystemProvider(renderTargetDir)
    const { files } = await publishPageRendered(
      'home',
      createContentRoot(storage, starterDir),
      target,
      undefined,
      templatesDir,
      undefined,
      site,
    )
    expect(files).toBeGreaterThanOrEqual(2) // index.html + styles.{hash}.css

    // Check page HTML exists with ESI tags and title from content
    const html = await target.readFile('pages/home/index.html')
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<!--esi:/fragments/header/index.html-->')
    expect(html).toContain('Welcome to Gazetta')
    // ESI publish path now runs resolveSeoTags for <head> SEO injection.
    // metadata.title wins via the fallback chain.
    expect(html).toContain('<title>Gazetta — Composable CMS</title>')

    // Check hashed CSS exists
    const entries = await target.readDir('pages/home')
    const cssFiles = entries.filter(e => e.name.endsWith('.css'))
    expect(cssFiles.length).toBe(1)
    expect(cssFiles[0].name).toMatch(/^styles\.[a-f0-9]{8}\.css$/)
  })

  it('publishes a fragment as HTML with hashed CSS', async () => {
    const target = createFilesystemProvider(renderTargetDir)

    const { files } = await publishFragmentRendered(
      'header',
      createContentRoot(storage, starterDir),
      target,
      templatesDir,
      undefined,
      site,
    )
    expect(files).toBeGreaterThanOrEqual(2) // index.html + styles.{hash}.css

    const html = await target.readFile('fragments/header/index.html')
    expect(html).toContain('<head>')
    expect(html).toContain('stylesheet')
    expect(html).toContain('Gazetta')

    const entries = await target.readDir('fragments/header')
    const cssFiles = entries.filter(e => e.name.endsWith('.css'))
    expect(cssFiles.length).toBe(1)
  })

  it('cleans up old hashed files when content changes', async () => {
    const target = createFilesystemProvider(renderTargetDir)

    // First publish

    await publishFragmentRendered(
      'header',
      createContentRoot(storage, starterDir),
      target,
      templatesDir,
      undefined,
      site,
    )
    const entries1 = await target.readDir('fragments/header')
    const css1 = entries1.find(e => e.name.endsWith('.css'))!.name

    // Write a fake old hashed CSS file
    await target.writeFile(`fragments/header/styles.00000000.css`, '.old {}')
    const entriesBefore = await target.readDir('fragments/header')
    expect(entriesBefore.filter(e => e.name.endsWith('.css')).length).toBe(2)

    // Publish again — same content, same hash

    await publishFragmentRendered(
      'header',
      createContentRoot(storage, starterDir),
      target,
      templatesDir,
      undefined,
      site,
    )
    const entriesAfter = await target.readDir('fragments/header')
    const cssAfter = entriesAfter.filter(e => e.name.endsWith('.css'))

    // Old fake file should be cleaned up, real file kept
    expect(cssAfter.length).toBe(1)
    expect(cssAfter[0].name).toBe(css1)
  })

  it('page publish cleans up old hashed JS files', async () => {
    const target = createFilesystemProvider(renderTargetDir)

    // First publish
    await publishPageRendered(
      'home',
      createContentRoot(storage, starterDir),
      target,
      undefined,
      templatesDir,
      undefined,
      site,
    )

    // Write fake old files
    await target.writeFile('pages/home/styles.00000000.css', '.old {}')
    await target.writeFile('pages/home/script.00000000.js', '// old')

    // Publish again
    await publishPageRendered(
      'home',
      createContentRoot(storage, starterDir),
      target,
      undefined,
      templatesDir,
      undefined,
      site,
    )
    const entries = await target.readDir('pages/home')
    const oldCss = entries.filter(e => e.name === 'styles.00000000.css')
    const oldJs = entries.filter(e => e.name === 'script.00000000.js')
    expect(oldCss.length).toBe(0)
    expect(oldJs.length).toBe(0)
  })

  it('bakes cache config comment into page HTML with defaults', async () => {
    const target = createFilesystemProvider(renderTargetDir)
    await publishPageRendered(
      'home',
      createContentRoot(storage, starterDir),
      target,
      undefined,
      templatesDir,
      undefined,
      site,
    )
    const html = await target.readFile('pages/home/index.html')
    expect(html).toMatch(/^<!--cache:browser=0,edge=86400-->/)
    expect(html).toContain('<!DOCTYPE html>')
  })

  it('bakes target cache config into page HTML', async () => {
    const target = createFilesystemProvider(renderTargetDir)
    await publishPageRendered(
      'home',
      createContentRoot(storage, starterDir),
      target,
      { browser: 120, edge: 3600 },
      templatesDir,
      undefined,
      site,
    )
    const html = await target.readFile('pages/home/index.html')
    expect(html).toMatch(/^<!--cache:browser=120,edge=3600-->/)
  })

  it('cache comment is on first line before DOCTYPE', async () => {
    const target = createFilesystemProvider(renderTargetDir)
    await publishPageRendered(
      'home',
      createContentRoot(storage, starterDir),
      target,
      undefined,
      templatesDir,
      undefined,
      site,
    )
    const html = await target.readFile('pages/home/index.html')
    const lines = html.split('\n')
    expect(lines[0]).toMatch(/^<!--cache:/)
    expect(lines[1]).toBe('<!DOCTYPE html>')
  })
})

describe('publishPageStatic', () => {
  const projectRoot2 = resolve(import.meta.dirname, '../../../examples/starter')
  const starterDir = resolve(projectRoot2, 'sites/main/targets/local')
  const templatesDir = resolve(projectRoot2, 'templates')
  const storage = createFilesystemProvider()
  const staticTargetDir = tempDir('static-test-' + Date.now())
  let site: Site

  beforeAll(async () => {
    const manifest = await starterManifest()
    site = await loadSite({ siteDir: starterDir, storage, templatesDir, manifest })
  })

  afterEach(async () => {
    await rm(staticTargetDir, { recursive: true, force: true })
  })

  it('publishes fully assembled HTML at URL path', async () => {
    const target = createFilesystemProvider(staticTargetDir)

    await publishPageStatic('home', createContentRoot(storage, starterDir), target, templatesDir, undefined, site)
    const html = await target.readFile('index.html')
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('Welcome to Gazetta')
    // Static publish uses renderPage which runs the SEO fallback chain.
    // metadata.title wins over content.title.
    expect(html).toContain('<title>Gazetta — Composable CMS</title>')
    // Fragments baked in
    expect(html).toContain('Gazetta') // from header
    expect(html).toContain('© 2026') // from footer
    // No ESI tags
    expect(html).not.toContain('<!--esi')
  })

  it('publishes about page at /about/index.html', async () => {
    const target = createFilesystemProvider(staticTargetDir)

    await publishPageStatic('about', createContentRoot(storage, starterDir), target, templatesDir, undefined, site)
    const html = await target.readFile('about/index.html')
    expect(html).toContain('About Gazetta')
    expect(html).not.toContain('<!--esi')
  })

  it('includes inline CSS and JS', async () => {
    const target = createFilesystemProvider(staticTargetDir)

    await publishPageStatic('home', createContentRoot(storage, starterDir), target, templatesDir, undefined, site)
    const html = await target.readFile('index.html')
    expect(html).toContain('<style>')
    // Counter JS should be inline
    expect(html).toContain('script type="module"')
  })

  it('no separate CSS/JS files', async () => {
    const target = createFilesystemProvider(staticTargetDir)

    await publishPageStatic('home', createContentRoot(storage, starterDir), target, templatesDir, undefined, site)
    const entries = await target.readDir('.')
    const cssOrJs = entries.filter(e => e.name.endsWith('.css') || e.name.endsWith('.js'))
    expect(cssOrJs.length).toBe(0)
  })
})

describe('isEditable', () => {
  it('defaults to true for local environment (explicit or unset)', async () => {
    const { isEditable } = await import('../src/types.js')
    expect(isEditable({ storage: { type: 'filesystem', path: './dist' } })).toBe(true)
    expect(isEditable({ storage: { type: 'r2' }, environment: 'local' })).toBe(true)
    // Unset environment → defaults to 'local' → editable
    expect(isEditable({ storage: { type: 'r2' } })).toBe(true)
  })

  it('defaults to false for staging and production', async () => {
    const { isEditable } = await import('../src/types.js')
    expect(isEditable({ storage: { type: 'r2' }, environment: 'staging' })).toBe(false)
    expect(isEditable({ storage: { type: 'r2' }, environment: 'production' })).toBe(false)
  })

  it('respects explicit editable: false on local target', async () => {
    const { isEditable } = await import('../src/types.js')
    expect(isEditable({ storage: { type: 'filesystem', path: './dist' }, editable: false })).toBe(false)
  })

  it('respects explicit editable: true on staging/production', async () => {
    const { isEditable } = await import('../src/types.js')
    expect(isEditable({ storage: { type: 'r2' }, environment: 'staging', editable: true })).toBe(true)
    expect(isEditable({ storage: { type: 'r2' }, environment: 'production', editable: true })).toBe(true)
  })
})

describe('getType', () => {
  // Import dynamically to avoid circular deps
  it('returns dynamic when worker configured', async () => {
    const { getType } = await import('../src/types.js')
    expect(getType({ storage: { type: 'r2' }, worker: { type: 'cloudflare' } })).toBe('dynamic')
  })

  it('returns static when no worker', async () => {
    const { getType } = await import('../src/types.js')
    expect(getType({ storage: { type: 'filesystem', path: './dist' } })).toBe('static')
  })

  it('respects explicit type over worker config', async () => {
    const { getType } = await import('../src/types.js')
    // Dynamic without worker (for gazetta serve)
    expect(getType({ storage: { type: 's3' }, type: 'dynamic' })).toBe('dynamic')
    // Static even with worker (override)
    expect(getType({ storage: { type: 'r2' }, worker: { type: 'cloudflare' }, type: 'static' })).toBe('static')
  })
})

describe('findDependentsFromSidecars', () => {
  it('returns pages that reference a fragment via reverse fragment-deps sidecars', async () => {
    const { findDependentsFromSidecars } = await import('../src/publish.js')
    const target = createFilesystemProvider(targetDir)
    // Reverse-sidecar shape: .gazetta/fragment-deps/{frag}/{encoded-item}
    // (per step 13b — replaces the legacy .uses-* forward sidecars).
    await writeTestFile(targetDir, '.gazetta/fragment-deps/header/pages.home', '')
    await writeTestFile(targetDir, '.gazetta/fragment-deps/footer/pages.home', '')
    await writeTestFile(targetDir, '.gazetta/fragment-deps/header/pages.about', '')
    await writeTestFile(targetDir, '.gazetta/fragment-deps/header/pages.blog.[slug]', '')

    const r = await findDependentsFromSidecars(createContentRoot(target), { fragment: 'header' })
    expect(r.pages.sort()).toEqual(['about', 'blog/[slug]', 'home'])
    expect(r.fragments).toEqual([])
  })

  it('walks transitive fragment→fragment references', async () => {
    const { findDependentsFromSidecars } = await import('../src/publish.js')
    const target = createFilesystemProvider(targetDir)
    // header references inner-logo; home references header. Querying
    // inner-logo must BFS through header to find home.
    await writeTestFile(targetDir, '.gazetta/fragment-deps/inner-logo/fragments.header', '')
    await writeTestFile(targetDir, '.gazetta/fragment-deps/header/pages.home', '')

    const r = await findDependentsFromSidecars(createContentRoot(target), { fragment: 'inner-logo' })
    expect(r.pages).toEqual(['home'])
    expect(r.fragments).toEqual(['header'])
  })

  it('returns items that use a given template', async () => {
    const { findDependentsFromSidecars } = await import('../src/publish.js')
    const target = createFilesystemProvider(targetDir)
    // Real published state always has .hash alongside .uses-* / .tpl-*
    await writeTestFile(targetDir, 'pages/home/.11111111.hash', '')
    await writeTestFile(targetDir, 'pages/home/.uses-header', '')
    await writeTestFile(targetDir, 'pages/home/.tpl-page-default', '')
    await writeTestFile(targetDir, 'pages/blog/.22222222.hash', '')
    await writeTestFile(targetDir, 'pages/blog/.tpl-page-blog', '')
    await writeTestFile(targetDir, 'fragments/header/.33333333.hash', '')
    await writeTestFile(targetDir, 'fragments/header/.tpl-header-layout', '')

    const r = await findDependentsFromSidecars(createContentRoot(target), { template: 'page-default' })
    expect(r.pages).toEqual(['home'])
    expect(r.fragments).toEqual([])
  })

  it('returns empty sets when target has no sidecars', async () => {
    const { findDependentsFromSidecars } = await import('../src/publish.js')
    const target = createFilesystemProvider(targetDir)
    const r = await findDependentsFromSidecars(createContentRoot(target), { fragment: 'header' })
    expect(r.pages).toEqual([])
    expect(r.fragments).toEqual([])
  })

  it('accepts baseDir for source-storage queries (unrooted provider)', async () => {
    const { findDependentsFromSidecars } = await import('../src/publish.js')
    const sourceDir = join(targetDir, '../source-root/sites/main')
    await writeTestFile(sourceDir, '.gazetta/fragment-deps/header/pages.home', '')
    const source = createFilesystemProvider()

    const r = await findDependentsFromSidecars(createContentRoot(source, sourceDir), { fragment: 'header' })
    expect(r.pages).toEqual(['home'])
  })
})

describe('SEO publish integration', () => {
  const projectRoot2 = resolve(import.meta.dirname, '../../../examples/starter')
  const starterDir = resolve(projectRoot2, 'sites/main/targets/local')
  const templatesDir = resolve(projectRoot2, 'templates')
  const storage = createFilesystemProvider()
  const seoTargetDir = tempDir('seo-publish-test-' + Date.now())
  let seoManifest: Awaited<ReturnType<typeof starterManifest>>

  beforeAll(async () => {
    seoManifest = await starterManifest()
  })

  beforeEach(async () => {
    await mkdir(seoTargetDir, { recursive: true })
  })
  afterEach(async () => {
    await rm(seoTargetDir, { recursive: true, force: true })
  })

  it('.pub sidecar is written with timestamp after static publish', { timeout: 15_000 }, async () => {
    const target = createFilesystemProvider(seoTargetDir)
    const { hashManifest } = await import('../src/hash.js')
    const { loadSite } = await import('../src/site-loader.js')
    const { scanTemplates, templateHashesFrom } = await import('../src/templates-scan.js')

    const contentRoot = createContentRoot(storage, starterDir)
    const site = await loadSite({ contentRoot, templatesDir, manifest: seoManifest })
    const templateInfos = await scanTemplates(templatesDir, projectRoot2)
    const templateHashes = templateHashesFrom(templateInfos)
    const page = site.pages.get('home')!
    const hash = hashManifest(page, { templateHashes })

    const before = Date.now()
    await publishPageStatic('home', contentRoot, target, templatesDir, hash, site)
    const after = Date.now()

    // The .pub-* sidecar should exist on the target under pages/home/
    const entries = await target.readDir('pages/home')
    const pubFile = entries.find(e => e.name.startsWith('.pub-'))
    expect(pubFile).toBeDefined()
    expect(pubFile!.name).toMatch(/^\.pub-\d{8}T\d{6}Z$/)

    // Parse and check timestamp is within the test window.
    // compactTimestamp truncates milliseconds, so the parsed value
    // can be up to 1s before `before`. Use a 2s window.
    const { parsePubSidecarName } = await import('../src/hash.js')
    const parsed = parsePubSidecarName(pubFile!.name)
    expect(parsed).not.toBeNull()
    expect(parsed!.noindex).toBe(false)
    const ts = new Date(parsed!.lastPublished).getTime()
    expect(ts).toBeGreaterThanOrEqual(before - 2000)
    expect(ts).toBeLessThanOrEqual(after + 2000)
  })

  it('.pub sidecar has noindex flag when page metadata contains noindex', async () => {
    // Create a source with a noindex page
    const noindexSourceDir = tempDir('noindex-source-' + Date.now())
    await mkdir(join(noindexSourceDir, 'pages/secret'), { recursive: true })
    await writeFile(
      join(noindexSourceDir, 'pages/secret/page.json'),
      JSON.stringify({
        template: 'page-default',
        content: { title: 'Secret' },
        metadata: { robots: 'noindex' },
      }),
    )
    // Copy site.yaml from starter
    const { readFile: readF } = await import('node:fs/promises')
    await writeFile(join(noindexSourceDir, 'site.yaml'), await readF(join(starterDir, '../../site.yaml'), 'utf-8'))

    const target = createFilesystemProvider(seoTargetDir)
    const { hashManifest } = await import('../src/hash.js')
    const { loadSite } = await import('../src/site-loader.js')
    const { scanTemplates, templateHashesFrom } = await import('../src/templates-scan.js')

    const contentRoot = createContentRoot(createFilesystemProvider(), noindexSourceDir)
    const site = await loadSite({ contentRoot, templatesDir, manifest: seoManifest })
    const templateInfos = await scanTemplates(templatesDir, projectRoot2)
    const templateHashes = templateHashesFrom(templateInfos)
    const page = site.pages.get('secret')!
    const hash = hashManifest(page, { templateHashes })

    await publishPageStatic('secret', contentRoot, target, templatesDir, hash, site)

    const entries = await target.readDir('pages/secret')
    const pubFile = entries.find(e => e.name.startsWith('.pub-'))
    expect(pubFile).toBeDefined()
    expect(pubFile!.name).toMatch(/-noindex$/)

    const { parsePubSidecarName } = await import('../src/hash.js')
    const parsed = parsePubSidecarName(pubFile!.name)
    expect(parsed!.noindex).toBe(true)

    await rm(noindexSourceDir, { recursive: true, force: true })
  })

  it('sitemap.xml is generated from target sidecars after publish', async () => {
    const target = createFilesystemProvider(seoTargetDir)
    const { hashManifest } = await import('../src/hash.js')
    const { loadSite } = await import('../src/site-loader.js')
    const { scanTemplates, templateHashesFrom } = await import('../src/templates-scan.js')
    const { listSidecars } = await import('../src/sidecars.js')
    const { generateSitemap } = await import('../src/sitemap.js')

    const contentRoot = createContentRoot(storage, starterDir)
    const site = await loadSite({ contentRoot, templatesDir, manifest: seoManifest })
    const templateInfos = await scanTemplates(templatesDir, projectRoot2)
    const templateHashes = templateHashesFrom(templateInfos)

    // Publish home + about
    for (const name of ['home', 'about']) {
      const page = site.pages.get(name)!
      const hash = hashManifest(page, { templateHashes })
      await publishPageStatic(name, contentRoot, target, templatesDir, hash, site)
    }

    // Generate sitemap from target sidecars
    const sidecars = await listSidecars(target, 'pages')
    expect(sidecars.size).toBe(2)

    const xml = generateSitemap({
      siteUrl: 'https://example.com',
      pages: sidecars,
    })
    expect(xml).not.toBeNull()
    expect(xml).toContain('<loc>https://example.com/</loc>')
    expect(xml).toContain('<loc>https://example.com/about</loc>')
    expect(xml).toContain('<lastmod>')

    // Write and verify it's readable
    await target.writeFile('sitemap.xml', xml!)
    const stored = await target.readFile('sitemap.xml')
    expect(stored).toBe(xml)
  })

  it('robots.txt is generated with sitemap reference', async () => {
    const { generateRobotsTxt } = await import('../src/robots.js')
    const target = createFilesystemProvider(seoTargetDir)

    const txt = generateRobotsTxt({ siteUrl: 'https://example.com' })
    await target.writeFile('robots.txt', txt)

    const stored = await target.readFile('robots.txt')
    expect(stored).toContain('User-agent: *')
    expect(stored).toContain('Sitemap: https://example.com/sitemap.xml')
  })
})
