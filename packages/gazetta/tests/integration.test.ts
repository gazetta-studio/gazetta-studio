import { describe, it, expect } from 'vitest'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { loadSite } from '../src/site-loader.js'
import { resolvePage } from '../src/resolver.js'
import { renderComponent, renderPage } from '../src/renderer.js'
import {
  starterTargetDir as siteDir,
  starterTemplatesDir as templatesDir,
  starterManifest,
} from './_helpers/starter.js'
import './_helpers/load-dompurify.js'

const storage = createFilesystemProvider()

describe('starter site', () => {
  it('loads the site', async () => {
    const site = await loadSite({ siteDir, storage, templatesDir, manifest: await starterManifest() })
    expect(site.manifest.name).toBe('Gazetta Starter')
    expect(site.pages.size).toBeGreaterThanOrEqual(3)
    expect(site.fragments.size).toBe(2)
    expect(site.pages.has('home')).toBe(true)
    expect(site.pages.has('about')).toBe(true)
    expect(site.pages.has('blog/[slug]')).toBe(true)
    expect(site.fragments.has('header')).toBe(true)
    expect(site.fragments.has('footer')).toBe(true)
  })

  it('resolves and renders the home page', async () => {
    const site = await loadSite({ siteDir, storage, templatesDir, manifest: await starterManifest() })
    const page = site.pages.get('home')!
    const resolved = await resolvePage('home', site)
    const html = await renderPage(resolved, { metadata: page.metadata, route: page.route })

    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<title>Gazetta — Composable CMS</title>')
    expect(html).toContain('Gazetta')
    expect(html).toContain('href="/"')
    expect(html).toContain('href="/about"')
    expect(html).toContain('Welcome to Gazetta')
    expect(html).toContain('composable components')
    expect(html).toContain('© 2026 Gazetta')
  })

  it('resolves and renders the about page', async () => {
    const site = await loadSite({ siteDir, storage, templatesDir, manifest: await starterManifest() })
    const page = site.pages.get('about')!
    const resolved = await resolvePage('about', site)
    const html = await renderPage(resolved, { metadata: page.metadata, route: page.route })

    expect(html).toContain('<title>About — Gazetta</title>')
    expect(html).toContain('About Gazetta')
    expect(html).toContain('stateless CMS')
    expect(html).toContain('© 2026 Gazetta')
  })

  it('shared fragments produce identical output across pages', async () => {
    const site = await loadSite({ siteDir, storage, templatesDir, manifest: await starterManifest() })
    const homeResolved = await resolvePage('home', site)
    const aboutResolved = await resolvePage('about', site)

    const stripScope = (html: string) => html.replace(/data-gz="[^"]+"/g, 'data-gz=""')

    const homeHeader = stripScope((await renderComponent(homeResolved.children[0])).html)
    const aboutHeader = stripScope((await renderComponent(aboutResolved.children[0])).html)
    expect(homeHeader).toBe(aboutHeader)

    const homeFooter = stripScope((await renderComponent(homeResolved.children[homeResolved.children.length - 1])).html)
    const aboutFooter = stripScope(
      (await renderComponent(aboutResolved.children[aboutResolved.children.length - 1])).html,
    )
    expect(homeFooter).toBe(aboutFooter)
  })

  it('page has correct component tree structure', async () => {
    const site = await loadSite({ siteDir, storage, templatesDir, manifest: await starterManifest() })
    const resolved = await resolvePage('home', site)

    // @header, hero, features, demo, vue-demo, banner, @footer
    expect(resolved.children).toHaveLength(7)

    const header = resolved.children[0]
    expect(header.children).toHaveLength(2)

    const hero = resolved.children[1]
    expect(hero.children).toHaveLength(0)
    expect(hero.content?.title).toBe('Welcome to Gazetta')

    const features = resolved.children[2]
    expect(features.children).toHaveLength(3)

    // demo (counter) is a leaf
    const demo = resolved.children[3]
    expect(demo.children).toHaveLength(0)

    // vue-demo (Vue SSR) is a leaf
    const vueDemo = resolved.children[4]
    expect(vueDemo.children).toHaveLength(0)
    expect(vueDemo.content?.heading).toBe('Vue SSR Works')

    // banner is a leaf with custom field
    const banner = resolved.children[5]
    expect(banner.children).toHaveLength(0)
    expect(banner.content?.heading).toBe('Get Started Today')

    const footer = resolved.children[6]
    expect(footer.children).toHaveLength(1)
  })

  it('renders React SSR templates (feature cards)', async () => {
    const site = await loadSite({ siteDir, storage, templatesDir, manifest: await starterManifest() })
    const resolved = await resolvePage('home', site)
    const html = await renderPage(resolved)

    expect(html).toContain('Why Gazetta')
    expect(html).toContain('<div class="feature-card">')
    expect(html).toContain('Fast')
    expect(html).toContain('Composable')
    expect(html).toContain('Open Source')
    expect(html).toContain('Edge composition at request time')
  })

  it('discovers nested dynamic route pages', async () => {
    const site = await loadSite({ siteDir, storage, templatesDir, manifest: await starterManifest() })
    const blogPage = site.pages.get('blog/[slug]')
    expect(blogPage).toBeDefined()
    expect(blogPage!.route).toBe('/blog/:slug')
  })

  it('resolves and renders blog page with route params', async () => {
    const site = await loadSite({ siteDir, storage, templatesDir, manifest: await starterManifest() })
    const page = site.pages.get('blog/[slug]')!
    const resolved = await resolvePage('blog/[slug]', site)
    const html = await renderPage(resolved, {
      routeParams: { slug: 'hello-world' },
      metadata: page.metadata,
      route: page.route,
    })

    expect(html).toContain('<title>Blog Post</title>')
    expect(html).toContain('Hello from Gazetta')
    expect(html).toContain('The Gazetta Team')
    expect(html).toContain('© 2026 Gazetta')
  })

  it('renders valid HTML document with scoped CSS', async () => {
    const site = await loadSite({ siteDir, storage, templatesDir, manifest: await starterManifest() })
    const resolved = await resolvePage('home', site)
    const html = await renderPage(resolved)

    expect(html).toMatch(/^<!DOCTYPE html>/)
    expect(html).toContain('<html lang="en">')
    expect(html).toContain('<meta charset="UTF-8">')
    expect(html).toContain('<style>')
    expect(html).toContain('</html>')
    expect(html).toContain('[data-gz=')
    expect(html).toContain('data-gz=')
  })

  it('renders unique data-gz IDs per component on all pages', async () => {
    const site = await loadSite({ siteDir, storage, templatesDir, manifest: await starterManifest() })
    for (const pageName of site.pages.keys()) {
      const resolved = await resolvePage(pageName, site)
      const html = await renderPage(resolved)
      const divIds = [...html.matchAll(/<div data-gz="([^"]+)">/g)].map(m => m[1])
      if (divIds.length === 0) continue // pages with only content (e.g. 404) may have no data-gz divs
      expect(new Set(divIds).size).toBe(divIds.length) // all unique within the page
    }
  })

  it('fragment children have unique IDs (nested components)', async () => {
    const site = await loadSite({ siteDir, storage, templatesDir, manifest: await starterManifest() })
    const resolved = await resolvePage('home', site)
    const html = await renderPage(resolved)
    const divIds = [...html.matchAll(/<div data-gz="([^"]+)">/g)].map(m => m[1])

    // Home page has @header (with logo, nav), hero, features (with children), demo, @footer (with copyright)
    // All must be unique including fragment children
    expect(divIds.length).toBeGreaterThanOrEqual(8)
    expect(new Set(divIds).size).toBe(divIds.length)
  })

  it('same fragment on different pages gets same IDs', async () => {
    const site = await loadSite({ siteDir, storage, templatesDir, manifest: await starterManifest() })
    const homeHtml = await renderPage(await resolvePage('home', site))
    const aboutHtml = await renderPage(await resolvePage('about', site))

    // @header should have the same data-gz ID on both pages
    const homeHeaderId = homeHtml.match(/<div data-gz="([^"]+)">.*?site-header/s)?.[1]
    const aboutHeaderId = aboutHtml.match(/<div data-gz="([^"]+)">.*?site-header/s)?.[1]
    expect(homeHeaderId).toBeDefined()
    expect(homeHeaderId).toBe(aboutHeaderId)
  })

  it('data-gz IDs are deterministic across renders', async () => {
    const site = await loadSite({ siteDir, storage, templatesDir, manifest: await starterManifest() })
    const resolved = await resolvePage('home', site)
    const html1 = await renderPage(resolved)
    const html2 = await renderPage(resolved)
    const ids1 = [...html1.matchAll(/<div data-gz="([^"]+)">/g)].map(m => m[1])
    const ids2 = [...html2.matchAll(/<div data-gz="([^"]+)">/g)].map(m => m[1])
    expect(ids1).toEqual(ids2)
  })

  it('validates all pages resolve without errors', async () => {
    const site = await loadSite({ siteDir, storage, templatesDir, manifest: await starterManifest() })
    const errors: string[] = []
    for (const pageName of site.pages.keys()) {
      try {
        await resolvePage(pageName, site)
      } catch (err) {
        errors.push(`${pageName}: ${(err as Error).message}`)
      }
    }
    expect(errors).toEqual([])
  })
})
