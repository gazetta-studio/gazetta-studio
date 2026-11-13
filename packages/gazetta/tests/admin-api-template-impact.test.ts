/**
 * GET /api/v1/templates/:name/impact: the items that use a template, top
 * level or nested inside other components, each with its scanner issues.
 *
 * Each test builds a fresh `memoryStorage()` source (rule 26).
 */
import { describe, expect, it } from 'vitest'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import type { ValidationScanner } from '../src/validation/scanner.js'
import type { Issue } from '../src/validation/types.js'
import { fakeScanner } from './_helpers/fake-scanner.js'
import { memoryStorage } from './_helpers/memory-storage.js'

function build(scanner?: ValidationScanner) {
  const storage = memoryStorage()
  storage.seed({
    // Uses hero at the top level.
    'pages/landing/page.json': JSON.stringify({ route: '/landing', template: 'hero' }),
    // Uses hero two levels down, inside an inline composite.
    'pages/home/page.json': JSON.stringify({
      route: '/',
      template: 'page-default',
      components: [
        {
          name: 'intro',
          template: 'section',
          components: [{ name: 'banner', template: 'hero', content: { title: 'Hi' } }],
        },
      ],
    }),
    // Doesn't use hero.
    'pages/about/page.json': JSON.stringify({
      route: '/about',
      template: 'page-default',
      components: [{ name: 'body', template: 'text-block' }],
    }),
    'fragments/promo/fragment.json': JSON.stringify({ template: 'hero' }),
  })
  const source = createSourceContext({
    storage,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest: { name: 'impact-site' },
  })
  return createAdminApp({
    source,
    siteDir: '/test-project',
    templatesDir: '/test-project/templates',
    disableCacheStatsLogger: true,
    ...(scanner ? { validationScanner: scanner } : {}),
  })
}

const homeIssue: Issue = {
  validator: 'schema-conformance',
  severity: 'warn',
  message: 'banner.title: Required',
  itemPath: 'pages/home/page.json',
}
const unrelated: Issue = {
  validator: 'unused-fragment',
  severity: 'info',
  message: 'Not used',
  itemPath: 'pages/about/page.json',
}

interface Impact {
  template: string
  items: Array<{ kind: string; name: string; itemPath: string; issues: Issue[] }>
  affectedItemCount: number
}

async function impact(app: ReturnType<typeof build>, name: string): Promise<Impact> {
  const res = await app.request(`/api/v1/templates/${name}/impact`)
  expect(res.status).toBe(200)
  return (await res.json()) as Impact
}

describe('GET /api/v1/templates/:name/impact', () => {
  it('lists the pages and fragments using the template, nested inline components included', async () => {
    const body = await impact(build(), 'hero')
    expect(body.template).toBe('hero')
    expect(body.items.map(i => [i.kind, i.name, i.itemPath]).sort()).toEqual([
      ['fragment', 'promo', 'fragments/promo/fragment.json'],
      ['page', 'home', 'pages/home/page.json'],
      ['page', 'landing', 'pages/landing/page.json'],
    ])
    // Pages come before fragments.
    expect(body.items.at(-1)!.kind).toBe('fragment')
  })

  it("carries each item's issues from the scanner", async () => {
    const body = await impact(build(fakeScanner([homeIssue, unrelated])), 'hero')
    const byName = Object.fromEntries(body.items.map(i => [i.name, i.issues]))
    expect(byName).toEqual({ home: [homeIssue], landing: [], promo: [] })
    expect(body.affectedItemCount).toBe(1)
  })

  it('reports no issues when no scanner is configured', async () => {
    const body = await impact(build(), 'hero')
    expect(body.items.every(i => i.issues.length === 0)).toBe(true)
    expect(body.affectedItemCount).toBe(0)
  })

  it('returns an empty list for a template nothing uses, including one that does not exist', async () => {
    for (const name of ['card', 'no-such-template']) {
      expect(await impact(build(), name)).toEqual({ template: name, items: [], affectedItemCount: 0 })
    }
  })
})
