/**
 * The preview route (`admin-api/routes/preview.ts`): what GET and POST
 * `/preview/*` answer for pages, fragments, archived items, unsaved
 * overrides, empty targets and template errors.
 *
 * Unkillable mutants, kept here because no test can tell them apart:
 *  - The OpenAPI metadata of the preview routes (`htmlPage`, the response
 *    descriptions, the summaries): preview sits outside `/api`, so the
 *    published document never includes it.
 *  - Dropping `^` from the request-path regex or `$` from the fragment
 *    locale regex: `.*` and `(@.+)` already match from the start and to
 *    the end.
 *  - `e.stack ?? ''`'s right side: every error that reaches the catch
 *    has a stack.
 *  - `archivePlaceholder`'s `kind = 'page'` default: only `'fragment'`
 *    is ever compared.
 *
 * Per rule 26 (test-isolation paranoia): the error-path tests build a
 * fresh app per test; the starter-copy suite copies the starter into a
 * temp dir (never dirties the repo) and removes it after.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { rm, cp, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Hono } from 'hono'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext, loadSiteFromSource } from '../src/admin-api/source-context.js'
import { previewRoutes, withStructuralOverride } from '../src/admin-api/routes/preview.js'
import { loadSiteConfig, siteConfigToManifest } from '../src/config/loader.js'
import type { DraftOverrides, StorageProvider } from '../src/types.js'
import { memoryStorage } from './_helpers/memory-storage.js'
import { tempDir } from './_helpers/temp.js'

const realStarter = resolve(import.meta.dirname, '../../../examples/starter')
const createdRoots: string[] = []

afterAll(async () => {
  for (const root of createdRoots) {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

/**
 * Build an admin app over a fresh copy of the starter site, applying
 * `patch` to the copy first so a test can corrupt content on disk.
 * Mirrors the harness in preview-capability-gate.test.ts.
 */
async function buildStarterSource(patch?: (projectRoot: string) => Promise<void>) {
  const projectRoot = tempDir(`preview-route-${Date.now()}-${Math.random()}`)
  createdRoots.push(projectRoot)
  await rm(projectRoot, { recursive: true, force: true })
  await cp(realStarter, projectRoot, {
    recursive: true,
    filter: src => !src.includes('/dist') && !src.includes('/node_modules') && !src.includes('/.tmp'),
  })
  if (patch) await patch(projectRoot)
  const projectSiteDir = resolve(projectRoot, 'sites/main')
  const storage = createFilesystemProvider(resolve(projectSiteDir, 'targets/local'))
  const loaded = await loadSiteConfig(projectSiteDir)
  if (!loaded) throw new Error('site.config.ts missing')
  const manifest = siteConfigToManifest(loaded.config)
  const source = createSourceContext({ storage, siteDir: '', projectSiteDir, manifest })
  return { source, projectRoot, projectSiteDir, templatesDir: resolve(projectRoot, 'templates') }
}

async function buildStarterApp(patch?: (projectRoot: string) => Promise<void>): Promise<Hono> {
  const { source, projectRoot, projectSiteDir, templatesDir } = await buildStarterSource(patch)
  return createAdminApp({
    source,
    siteDir: projectSiteDir,
    templatesDir,
    adminDir: resolve(projectRoot, 'admin'),
    disableCacheStatsLogger: true,
  })
}

function postPreview(path: string, overrides?: unknown) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(overrides === undefined ? {} : { overrides }),
  }
}

describe('preview route registration and Cache-Control', () => {
  it('GET /preview/* returns Cache-Control: no-store', async () => {
    const app = await buildStarterApp()
    const res = await app.request('/preview/about')
    expect(res.status).toBe(200)
    // Preview always serves fresh content for editing - the documented
    // behavior the no-store header implements.
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('POST /preview/* returns Cache-Control: no-store', async () => {
    const app = await buildStarterApp()
    const res = await app.request('/preview/about', postPreview('/preview/about'))
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('GET /preview/ renders the home page (empty request path falls back to /)', async () => {
    const app = await buildStarterApp()
    const res = await app.request('/preview/')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Welcome to Gazetta')
  })

  it('GET /preview (no trailing slash) renders the home page', async () => {
    // Hono matches `/preview` against `/preview/*` with an empty
    // remainder; the `|| '/'` fallback in renderPreview is what maps it
    // to the home page.
    const app = await buildStarterApp()
    const res = await app.request('/preview')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Welcome to Gazetta')
  })

  it('GET /preview/<missing> returns the Page not found 404 body', async () => {
    const app = await buildStarterApp()
    const res = await app.request('/preview/nonexistent')
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('Page not found')
  })
})

describe('preview POST overrides', () => {
  it('POST without an overrides key renders the stored content', async () => {
    const app = await buildStarterApp()
    const res = await app.request('/preview/', postPreview('/preview/'))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Welcome to Gazetta')
  })

  it('POST with only overrides.content defaults structural to empty', async () => {
    const app = await buildStarterApp()
    const res = await app.request(
      '/preview/',
      postPreview('/preview/', { content: { hero: { title: 'Only Content Set' } } }),
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Only Content Set')
  })

  it('content overrides apply by treePath, including nested components', async () => {
    const app = await buildStarterApp()
    const res = await app.request(
      '/preview/',
      postPreview('/preview/', {
        content: {
          hero: { title: 'Override Hero Title' },
          'features/fast': { title: 'Override Nested Title' },
        },
        structural: {},
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Override Hero Title')
    expect(body).toContain('Override Nested Title')
    expect(body).not.toContain('Welcome to Gazetta')
  })

  it('a structural override replaces only the keyed manifest, leaving the stored site untouched', async () => {
    const app = await buildStarterApp()
    const res = await app.request(
      '/preview/',
      postPreview('/preview/', {
        content: {},
        structural: {
          'page:home': [
            {
              name: 'hero',
              template: 'hero',
              content: { title: 'Structural Override Home' },
            },
          ],
        },
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Structural Override Home')
    // The features section is gone from the overridden components array.
    expect(body).not.toContain('Why Gazetta?')

    // Each preview request loads the site fresh from storage, so the
    // follow-up render pins that the override was never persisted. The
    // in-memory immutability of withStructuralOverride itself is pinned
    // directly by the unit tests below.
    const after = await app.request('/preview/')
    expect(after.status).toBe(200)
    const afterBody = await after.text()
    expect(afterBody).toContain('Welcome to Gazetta')
    expect(afterBody).toContain('Why Gazetta?')
  })

  it('a structural override keyed to another page leaves this page unchanged', async () => {
    const app = await buildStarterApp()
    const res = await app.request(
      '/preview/about',
      postPreview('/preview/about', {
        content: {},
        structural: {
          'page:home': [{ name: 'hero', template: 'hero', content: { title: 'Not This Page' } }],
        },
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('About Gazetta')
    expect(body).not.toContain('Not This Page')
  })
})

/**
 * Mount `previewRoutes` the way `createAdminApp` does: behind a
 * principal. Bare mounting leaves `c.var.principal` unset and the
 * capability gate crashes before the route body runs.
 */
function previewApp(resolveFn: Parameters<typeof previewRoutes>[0]): Hono {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('principal', { id: 'test-user', role: 'admin', capabilities: ['read:pages'] })
    await next()
  })
  app.route('/', previewRoutes(resolveFn))
  return app
}

describe('preview empty target and loader errors', () => {
  it('a target with no site config returns the 404 placeholder', async () => {
    // Never-published publish-target: the source has content storage but
    // no project manifest, so loadSite throws a `loadSite:` error and the
    // preview shows the friendly placeholder instead of a 500.
    const storage = memoryStorage()
    const source = createSourceContext({ storage, siteDir: '', projectSiteDir: '/test-project' })
    const app = previewApp(async () => source)
    const res = await app.request('/preview/anything')
    expect(res.status).toBe(404)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await res.text()).toBe(
      '<!doctype html><html><body style="font-family:system-ui;padding:2rem;color:#525252">' +
        '<h2 style="margin:0 0 0.5rem">No content on this target yet</h2>' +
        '<p style="margin:0;font-size:0.875rem">Publish from an editable target to see a preview here.</p>' +
        '</body></html>',
    )
  })

  it('a non-loadSite loader error propagates instead of becoming the placeholder', async () => {
    // Storage whose reads fail with a plain (non-`loadSite:`) error: the
    // catch in renderPreview must rethrow it, so Hono answers 500 - a
    // mutant that turns every loader error into the 404 placeholder
    // (or swallows the rethrow) fails here.
    const failing = {
      ...memoryStorage(),
      readDir: () => Promise.reject(new Error('disk gone')),
      read: () => Promise.reject(new Error('disk gone')),
      exists: () => Promise.reject(new Error('disk gone')),
    } as unknown as StorageProvider
    const source = createSourceContext({
      storage: failing,
      siteDir: '',
      projectSiteDir: '/test-project',
      manifest: { name: 'test-site', targets: {} },
    })
    const app = previewApp(async () => source)
    const res = await app.request('/preview/anything')
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('No content on this target yet')
  })
})

describe('withStructuralOverride', () => {
  it('returns a copy with only the keyed manifest patched and never mutates the original Site', async () => {
    const { source, templatesDir } = await buildStarterSource()
    const site = await loadSiteFromSource(source, { templatesDir })
    const homeBefore = site.pages.get('home')
    if (!homeBefore) throw new Error('starter home page missing')
    const aboutBefore = site.pages.get('about')
    const componentsBefore = homeBefore.components

    const replacement: DraftOverrides['structural'][string] = [
      { name: 'hero', template: 'hero', content: { title: 'Unit Override' } },
    ]
    const patched = withStructuralOverride(
      site,
      { kind: 'page', name: 'home' },
      { content: {}, structural: { 'page:home': replacement } },
    )

    expect(patched).not.toBe(site)
    expect(patched.pages.get('home')?.components).toBe(replacement)
    // In-memory immutability: the original Site keeps its own manifest...
    expect(site.pages.get('home')).toBe(homeBefore)
    expect(site.pages.get('home')?.components).toBe(componentsBefore)
    // ...and only the patched manifest is cloned - unrelated state is shared.
    expect(patched.pages.get('about')).toBe(aboutBefore)
    expect(patched.fragments).toBe(site.fragments)
    expect(patched.manifest).toBe(site.manifest)
  })

  it('returns the original Site when no structural override matches the key', async () => {
    const { source, templatesDir } = await buildStarterSource()
    const site = await loadSiteFromSource(source, { templatesDir })
    expect(withStructuralOverride(site, { kind: 'page', name: 'home' }, { content: {}, structural: {} })).toBe(site)
    expect(
      withStructuralOverride(
        site,
        { kind: 'page', name: 'no-such-page' },
        { content: {}, structural: { 'page:no-such-page': [] } },
      ),
    ).toBe(site)
  })
})

describe('withStructuralOverride for fragments', () => {
  it('patches only the keyed fragment and leaves pages and the original Site alone', async () => {
    const { source, templatesDir } = await buildStarterSource()
    const site = await loadSiteFromSource(source, { templatesDir })
    const headerBefore = site.fragments.get('header')
    const replacement: DraftOverrides['structural'][string] = [
      { name: 'logo', template: 'logo', content: { text: 'x' } },
    ]
    const patched = withStructuralOverride(
      site,
      { kind: 'fragment', name: 'header' },
      { content: {}, structural: { 'fragment:header': replacement } },
    )
    expect(patched.fragments.get('header')?.components).toBe(replacement)
    expect(patched.fragments.get('header')?.template).toBe(headerBefore?.template)
    expect(patched.fragments.get('footer')).toBe(site.fragments.get('footer'))
    expect(patched.pages).toBe(site.pages)
    expect(site.fragments.get('header')).toBe(headerBefore)
  })

  it('returns the original Site for an override keyed to a fragment that does not exist', async () => {
    const { source, templatesDir } = await buildStarterSource()
    const site = await loadSiteFromSource(source, { templatesDir })
    const patched = withStructuralOverride(
      site,
      { kind: 'fragment', name: 'no-such-fragment' },
      { content: {}, structural: { 'fragment:no-such-fragment': [] } },
    )
    expect(patched).toBe(site)
  })
})

describe('preview fragment branch', () => {
  it('GET /preview/@header renders the fragment', async () => {
    const app = await buildStarterApp()
    const res = await app.request('/preview/@header')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const body = await res.text()
    expect(body).toContain('Gazetta')
    expect(body).not.toContain('Template Error')
  })

  it('GET /preview/fr/@header strips the locale prefix and renders the fragment', async () => {
    const app = await buildStarterApp()
    const res = await app.request('/preview/fr/@header')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Gazetta')
    expect(body).not.toContain('Template Error')
  })

  it('GET /preview/@missing answers the Template Error 500, escaping the message', async () => {
    const app = await buildStarterApp()
    // The fragment name carries angle brackets so the escaping is
    // actually exercised: an unescaped render would emit the raw name
    // and inject markup into the error page.
    const res = await app.request('/preview/@%3Cscript%3Ealert(1)')
    expect(res.status).toBe(500)
    const body = await res.text()
    expect(body).toContain('Template Error')
    expect(body).not.toContain('<script>alert(1)')
    expect(body).toContain('&lt;script&gt;alert(1)')
  })

  it('a page whose template cannot render answers the Template Error 500', async () => {
    const app = await buildStarterApp(async projectRoot => {
      const dir = resolve(projectRoot, 'sites/main/targets/local/pages/broken')
      await mkdir(dir, { recursive: true })
      await writeFile(resolve(dir, 'page.json'), JSON.stringify({ template: 'no-such-template', content: {} }))
    })
    const res = await app.request('/preview/broken')
    expect(res.status).toBe(500)
    const body = await res.text()
    expect(body).toContain('Template Error')
  })
})

/** Write a manifest into the starter copy's local target. */
async function writeManifest(projectRoot: string, dir: string, file: string, manifest: unknown) {
  const path = resolve(projectRoot, 'sites/main/targets/local', dir)
  await mkdir(path, { recursive: true })
  await writeFile(resolve(path, file), JSON.stringify(manifest))
}

const PLACEHOLDER_OPEN = '<!doctype html><html><body style="font-family:system-ui;padding:2rem;color:#525252">'
const PLACEHOLDER_CLOSE = '</body></html>'

describe('preview archive placeholders', () => {
  it('an archived page without an alias shows the page wording of the 410 placeholder', async () => {
    const app = await buildStarterApp(root => writeManifest(root, 'pages/gone-page', 'page.json', { archived: true }))
    const res = await app.request('/preview/gone-page')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(
      PLACEHOLDER_OPEN +
        '<h2 style="margin:0 0 0.5rem">410 Gone</h2>' +
        '<p style="margin:0;font-size:0.875rem">This page is archived. Visitors get a "Gone" response.</p>' +
        PLACEHOLDER_CLOSE,
    )
  })

  it('an archived fragment without an alias shows the fragment wording of the 410 placeholder', async () => {
    const app = await buildStarterApp(root =>
      writeManifest(root, 'fragments/gone-frag', 'fragment.json', { archived: true }),
    )
    const res = await app.request('/preview/@gone-frag')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('This fragment is archived. References to it cannot resolve.')
    expect(body).not.toContain('Visitors get a "Gone" response')
  })

  it('a page alias links to the aliased page route, not its name', async () => {
    // `home` lives at `/`, so `/${aliasOf}` would wrongly give `/home`.
    const app = await buildStarterApp(root =>
      writeManifest(root, 'pages/old-home', 'page.json', { archived: true, aliasOf: 'home' }),
    )
    const body = await (await app.request('/preview/old-home')).text()
    expect(body).toContain('<h2 style="margin:0 0 0.5rem">301 → /</h2>')
    expect(body).toContain('Visitors are redirected to <a href="/">/</a>.')
  })

  it('a page alias to a name with no page falls back to /<name>, escaped', async () => {
    const app = await buildStarterApp(root =>
      writeManifest(root, 'pages/odd-alias', 'page.json', { archived: true, aliasOf: 'a&b"<c>' }),
    )
    const res = await app.request('/preview/odd-alias')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(
      PLACEHOLDER_OPEN +
        '<h2 style="margin:0 0 0.5rem">301 → /a&amp;b&quot;&lt;c&gt;</h2>' +
        '<p style="margin:0;font-size:0.875rem">Visitors are redirected to <a href="/a&amp;b&quot;&lt;c&gt;">/a&amp;b&quot;&lt;c&gt;</a>.</p>' +
        PLACEHOLDER_CLOSE,
    )
  })

  it('a fragment alias names @<alias>, escaped', async () => {
    const app = await buildStarterApp(root =>
      writeManifest(root, 'fragments/odd-frag', 'fragment.json', { archived: true, aliasOf: 'a&b"<c>' }),
    )
    expect(await (await app.request('/preview/@odd-frag')).text()).toBe(
      PLACEHOLDER_OPEN +
        '<h2 style="margin:0 0 0.5rem">301 → @a&amp;b&quot;&lt;c&gt;</h2>' +
        '<p style="margin:0;font-size:0.875rem">References to this fragment resolve to @a&amp;b&quot;&lt;c&gt;.</p>' +
        PLACEHOLDER_CLOSE,
    )
  })
})

describe('preview fragment overrides and locale prefix', () => {
  it('a structural override keyed fragment:<name> replaces that fragment’s components', async () => {
    const app = await buildStarterApp()
    const res = await app.request(
      '/preview/@header',
      postPreview('/preview/@header', {
        content: {},
        structural: { 'fragment:header': [{ name: 'logo', template: 'logo', content: { text: 'Only Logo' } }] },
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Only Logo')
    expect(body).not.toContain('href="/about"')
  })

  it('content overrides apply to a fragment’s components by treePath', async () => {
    const app = await buildStarterApp()
    const res = await app.request(
      '/preview/@header',
      postPreview('/preview/@header', { content: { '@header/logo': { text: 'Fragment Override' } }, structural: {} }),
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Fragment Override')
  })

  it('a region locale prefix (pt-br) is taken as the fragment preview locale', async () => {
    const app = await buildStarterApp()
    const res = await app.request('/preview/pt-br/@header')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<html lang="pt-br">')
  })

  it('a locale-looking segment after another segment is not a fragment preview', async () => {
    const app = await buildStarterApp()
    const res = await app.request('/preview/x/fr/@header')
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('<p>Page not found</p>')
  })
})

describe('preview page routing and SEO context', () => {
  it('a locale page renders with its own locale and metadata title', async () => {
    const app = await buildStarterApp()
    const body = await (await app.request('/preview/fr')).text()
    expect(body).toContain('<html lang="fr">')
    expect(body).toContain('<title>Gazetta — CMS Composable</title>')
  })

  it('dynamic route params reach the template by name', async () => {
    const app = await buildStarterApp(async root => {
      const dir = resolve(root, 'templates/params-echo')
      await mkdir(dir, { recursive: true })
      await writeFile(
        resolve(dir, 'index.ts'),
        "import { z } from 'zod'\n" +
          'export const schema = z.object({})\n' +
          'export default ({ params }: { params?: Record<string, string> }) => ' +
          '({ html: `<p id="params">${JSON.stringify(params ?? null)}</p>`, css: "", js: "" })\n',
      )
      await writeManifest(root, 'pages/echo/[slug]', 'page.json', { template: 'params-echo' })
    })
    const res = await app.request('/preview/echo/my-post')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<p id="params">{"slug":"my-post"}</p>')
  })

  it('a path with more segments than any route is not found', async () => {
    const app = await buildStarterApp()
    const res = await app.request('/preview/about/extra')
    expect(res.status).toBe(404)
  })
})

describe('preview Template Error escaping', () => {
  /** The message and stack-trace `<pre>` blocks of the error page. */
  function errorBlocks(body: string) {
    const msg = body.match(
      /<pre style="white-space:pre-wrap;font-size:0.875rem;line-height:1.7">([\s\S]*?)<\/pre>/,
    )?.[1]
    const stack = body.match(/<pre style="color:#52525b;font-size:0.75rem;margin-top:0.5rem">([\s\S]*?)<\/pre>/)?.[1]
    return { msg, stack }
  }

  it('a fragment error escapes angle brackets in both the message and the stack', async () => {
    const app = await buildStarterApp()
    const body = await (await app.request('/preview/@%3Cb%3Ex')).text()
    const { msg, stack } = errorBlocks(body)
    expect(msg).toContain('&lt;b&gt;x')
    expect(stack).toContain('&lt;b&gt;x')
    expect(msg).not.toMatch(/[<>]/)
    expect(stack).not.toMatch(/[<>]/)
  })

  it('a page error escapes angle brackets in both the message and the stack', async () => {
    const app = await buildStarterApp(root =>
      writeManifest(root, 'pages/broken-esc', 'page.json', { template: 'no<such>tpl', content: {} }),
    )
    const res = await app.request('/preview/broken-esc')
    expect(res.status).toBe(500)
    const { msg, stack } = errorBlocks(await res.text())
    expect(msg).toContain('&lt;such&gt;')
    expect(stack).toContain('&lt;such&gt;')
    expect(msg).not.toMatch(/[<>]/)
    expect(stack).not.toMatch(/[<>]/)
  })
})
