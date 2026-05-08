/**
 * Unit tests for the broken-links validator.
 *
 * Pre-rendered HTML strings + a stub Site exercise the link-extraction
 * + route-matching path. External / pseudo-protocol / anchor-only URLs
 * must be skipped; broken internal links surface as warns at background,
 * errors at pre-publish.
 */
import { describe, it, expect } from 'vitest'
import type { PageManifest } from '../src/types.js'
import type { Site } from '../src/site-loader.js'
import type { ContentRoot } from '../src/content-root.js'
import type { RenderedOutputAccess, SavedItem } from '../src/validation/types.js'
import { brokenLinks } from '../src/validation/validators/broken-links.js'

function buildSite(pages: Record<string, string>): Site {
  const pageMap = new Map<string, PageManifest & { dir: string }>()
  for (const [name, route] of Object.entries(pages)) {
    pageMap.set(name, { template: 'x', content: {}, route, dir: `pages/${name}` })
  }
  return {
    pages: pageMap,
    fragments: new Map(),
    pageLocales: new Map(),
    fragmentLocales: new Map(),
    manifest: { name: 't', targets: { local: {} } } as Site['manifest'],
    templatesDir: undefined,
  } as Site
}

const stubRoot = { rootPath: '', join: () => '' } as unknown as ContentRoot
const stubStorage = {} as never

function renderedAs(html: string): RenderedOutputAccess {
  return { htmlFor: async () => html }
}

const item: SavedItem = { kind: 'page', name: 'home', itemPath: 'pages/home/page.json' }

describe('broken-links validator', () => {
  it('produces no issues when all internal links resolve', async () => {
    const site = buildSite({ home: '/', about: '/about', contact: '/contact' })
    const html = `<a href="/about">about</a> <a href="/contact">contact</a> <a href="/">home</a>`
    const issues = await brokenLinks.validate({
      stage: 'background',
      site,
      contentRoot: stubRoot,
      storage: stubStorage,
      scope: { kind: 'background', item, manifest: { template: 't', content: {} } },
      renderedOutput: renderedAs(html),
    })
    expect(issues).toEqual([])
  })

  it('flags an internal link that does not match any page route', async () => {
    const site = buildSite({ home: '/', about: '/about' })
    const html = `<a href="/missing-page">broken</a>`
    const issues = await brokenLinks.validate({
      stage: 'background',
      site,
      contentRoot: stubRoot,
      storage: stubStorage,
      scope: { kind: 'background', item, manifest: { template: 't', content: {} } },
      renderedOutput: renderedAs(html),
    })
    expect(issues).toHaveLength(1)
    expect(issues[0].validator).toBe('broken-links')
    expect(issues[0].severity).toBe('warn')
    expect(issues[0].message).toContain('/missing-page')
  })

  it('skips external links', async () => {
    const site = buildSite({ home: '/' })
    const html = `<a href="https://example.com">ext</a> <a href="http://other.com">also</a>`
    const issues = await brokenLinks.validate({
      stage: 'background',
      site,
      contentRoot: stubRoot,
      storage: stubStorage,
      scope: { kind: 'background', item, manifest: { template: 't', content: {} } },
      renderedOutput: renderedAs(html),
    })
    expect(issues).toEqual([])
  })

  it('skips pseudo-protocols and anchors', async () => {
    const site = buildSite({ home: '/' })
    const html = `<a href="mailto:foo@bar.com">m</a> <a href="#section">a</a> <a href="tel:+1234">t</a>`
    const issues = await brokenLinks.validate({
      stage: 'background',
      site,
      contentRoot: stubRoot,
      storage: stubStorage,
      scope: { kind: 'background', item, manifest: { template: 't', content: {} } },
      renderedOutput: renderedAs(html),
    })
    expect(issues).toEqual([])
  })

  it('accepts asset paths without checking', async () => {
    const site = buildSite({ home: '/' })
    const html = `<img src="/assets/hero-abc123.jpg"> <link href="/assets/style.css">`
    const issues = await brokenLinks.validate({
      stage: 'background',
      site,
      contentRoot: stubRoot,
      storage: stubStorage,
      scope: { kind: 'background', item, manifest: { template: 't', content: {} } },
      renderedOutput: renderedAs(html),
    })
    expect(issues).toEqual([])
  })

  it('accepts dynamic route matches', async () => {
    const site = buildSite({ home: '/', 'blog/[slug]': '/blog/:slug' })
    const html = `<a href="/blog/hello-world">post</a>`
    const issues = await brokenLinks.validate({
      stage: 'background',
      site,
      contentRoot: stubRoot,
      storage: stubStorage,
      scope: { kind: 'background', item, manifest: { template: 't', content: {} } },
      renderedOutput: renderedAs(html),
    })
    expect(issues).toEqual([])
  })

  it('strips query + hash before matching', async () => {
    const site = buildSite({ home: '/', about: '/about' })
    const html = `<a href="/about?ref=home#bio">about</a>`
    const issues = await brokenLinks.validate({
      stage: 'background',
      site,
      contentRoot: stubRoot,
      storage: stubStorage,
      scope: { kind: 'background', item, manifest: { template: 't', content: {} } },
      renderedOutput: renderedAs(html),
    })
    expect(issues).toEqual([])
  })

  it('emits warn at pre-publish (operator promotes via publishAudit.strict)', async () => {
    // Per design-validation.md "Stage × validator matrix" + the
    // publish-audit's strict-promotion flow: validators stay warn at
    // every stage, and the orchestrator turns warns into errors at
    // the publish gate when the destination target opts into strict.
    const site = buildSite({ home: '/' })
    const html = `<a href="/missing">broken</a>`
    const issues = await brokenLinks.validate({
      stage: 'pre-publish',
      site,
      contentRoot: stubRoot,
      storage: stubStorage,
      scope: { kind: 'pre-publish', items: [item] },
      renderedOutput: renderedAs(html),
    })
    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('warn')
  })

  it('does not run on save-delta scope', async () => {
    const site = buildSite({ home: '/' })
    const html = `<a href="/missing">broken</a>`
    const issues = await brokenLinks.validate({
      stage: 'save-delta',
      site,
      contentRoot: stubRoot,
      storage: stubStorage,
      scope: {
        kind: 'save-delta',
        item,
        before: null,
        after: { template: 't', content: {} },
      },
      renderedOutput: renderedAs(html),
    })
    expect(issues).toEqual([])
  })

  it('returns no issues when renderedOutput is absent', async () => {
    const site = buildSite({ home: '/' })
    const issues = await brokenLinks.validate({
      stage: 'background',
      site,
      contentRoot: stubRoot,
      storage: stubStorage,
      scope: { kind: 'background', item, manifest: { template: 't', content: {} } },
    })
    expect(issues).toEqual([])
  })
})
