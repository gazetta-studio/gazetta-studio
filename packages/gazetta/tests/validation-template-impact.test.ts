/**
 * Unit tests for computeTemplateImpact (Validation Cut 6).
 *
 * Stub Sites + an injected issuesFor lookup exercise the recursive
 * walk + impact projection. The route, SSE event, and banner are
 * tested separately; this file pins the pure function.
 */
import { describe, expect, it } from 'vitest'
import type { Site } from '../src/site-loader.js'
import type { FragmentManifest, PageManifest } from '../src/types.js'
import { computeTemplateImpact } from '../src/validation/template-impact.js'
import type { Issue } from '../src/validation/types.js'

function buildSite(opts: {
  pages?: Record<string, PageManifest & { dir: string }>
  fragments?: Record<string, FragmentManifest & { dir: string }>
}): Site {
  return {
    pages: new Map(Object.entries(opts.pages ?? {})),
    fragments: new Map(Object.entries(opts.fragments ?? {})),
    pageLocales: new Map(),
    fragmentLocales: new Map(),
    manifest: { name: 't', targets: { local: {} } } as Site['manifest'],
    templatesDir: undefined,
  } as Site
}

const noIssues = () => [] as readonly Issue[]

describe('computeTemplateImpact', () => {
  it('lists pages whose top-level template matches', () => {
    const site = buildSite({
      pages: {
        home: { template: 'page-default', content: {}, route: '/', dir: 'pages/home' },
        about: { template: 'page-default', content: {}, route: '/about', dir: 'pages/about' },
        blog: { template: 'page-blog', content: {}, route: '/blog', dir: 'pages/blog' },
      },
    })
    const result = computeTemplateImpact(site, 'page-default', noIssues)
    expect(result.template).toBe('page-default')
    expect(result.items).toHaveLength(2)
    expect(result.items.map(i => i.name).sort()).toEqual(['about', 'home'])
  })

  it('lists fragments whose top-level template matches', () => {
    const site = buildSite({
      fragments: {
        header: { template: 'header-layout', content: {}, dir: 'fragments/header' },
        footer: { template: 'footer-layout', content: {}, dir: 'fragments/footer' },
      },
    })
    const result = computeTemplateImpact(site, 'header-layout', noIssues)
    expect(result.items).toHaveLength(1)
    expect(result.items[0].name).toBe('header')
    expect(result.items[0].kind).toBe('fragment')
  })

  it('orders pages first, then fragments', () => {
    const site = buildSite({
      pages: { p1: { template: 'shared', content: {}, route: '/p1', dir: 'pages/p1' } },
      fragments: { f1: { template: 'shared', content: {}, dir: 'fragments/f1' } },
    })
    const result = computeTemplateImpact(site, 'shared', noIssues)
    expect(result.items[0].kind).toBe('page')
    expect(result.items[1].kind).toBe('fragment')
  })

  it('finds nested inline components recursively', () => {
    const site = buildSite({
      pages: {
        home: {
          template: 'page-default',
          content: {},
          route: '/',
          dir: 'pages/home',
          components: [
            {
              name: 'wrapper',
              template: 'section',
              components: [
                {
                  name: 'inner',
                  template: 'hero', // ← deep match
                  content: { title: 'x' },
                },
              ],
            },
          ],
        },
      },
    })
    const result = computeTemplateImpact(site, 'hero', noIssues)
    expect(result.items).toHaveLength(1)
    expect(result.items[0].name).toBe('home')
  })

  it('deduplicates pages that use the template multiple times', () => {
    const site = buildSite({
      pages: {
        home: {
          template: 'hero', // top-level
          content: {},
          route: '/',
          dir: 'pages/home',
          components: [
            { name: 'second', template: 'hero', content: {} }, // and inline
          ],
        },
      },
    })
    const result = computeTemplateImpact(site, 'hero', noIssues)
    expect(result.items).toHaveLength(1)
  })

  it('skips pages and fragments that do not reference the template', () => {
    const site = buildSite({
      pages: { home: { template: 'page-default', content: {}, route: '/', dir: 'pages/home' } },
      fragments: { footer: { template: 'footer-layout', content: {}, dir: 'fragments/footer' } },
    })
    const result = computeTemplateImpact(site, 'unused-template', noIssues)
    expect(result.items).toEqual([])
    expect(result.affectedItemCount).toBe(0)
  })

  it('attaches issues from the lookup function per item', () => {
    const site = buildSite({
      pages: {
        home: { template: 'hero', content: {}, route: '/', dir: 'pages/home' },
        about: { template: 'hero', content: {}, route: '/about', dir: 'pages/about' },
      },
    })
    const issuesByPath: Record<string, Issue[]> = {
      'pages/home/page.json': [
        {
          validator: 'schema-conformance',
          severity: 'error',
          message: 'title: Required',
          itemPath: 'pages/home/page.json',
        },
      ],
      'pages/about/page.json': [],
    }
    const result = computeTemplateImpact(site, 'hero', path => issuesByPath[path] ?? [])
    expect(result.items).toHaveLength(2)
    const home = result.items.find(i => i.name === 'home')!
    expect(home.issues).toHaveLength(1)
    expect(home.issues[0].validator).toBe('schema-conformance')
    const about = result.items.find(i => i.name === 'about')!
    expect(about.issues).toEqual([])
  })

  it('counts only items with at least one issue toward affectedItemCount', () => {
    const site = buildSite({
      pages: {
        a: { template: 'hero', content: {}, route: '/a', dir: 'pages/a' },
        b: { template: 'hero', content: {}, route: '/b', dir: 'pages/b' },
        c: { template: 'hero', content: {}, route: '/c', dir: 'pages/c' },
      },
    })
    const issuesByPath: Record<string, Issue[]> = {
      'pages/a/page.json': [{ validator: 'x', severity: 'error', message: 'fail', itemPath: 'pages/a/page.json' }],
      'pages/b/page.json': [{ validator: 'x', severity: 'warn', message: 'warn', itemPath: 'pages/b/page.json' }],
      'pages/c/page.json': [],
    }
    const result = computeTemplateImpact(site, 'hero', path => issuesByPath[path] ?? [])
    expect(result.items).toHaveLength(3)
    expect(result.affectedItemCount).toBe(2) // a + b
  })
})
