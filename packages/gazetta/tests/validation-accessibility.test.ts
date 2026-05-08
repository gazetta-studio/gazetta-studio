/**
 * Unit tests for the accessibility validator (axe-core via jsdom).
 *
 * Pre-rendered HTML strings exercise the analyzer end-to-end. Tests pin:
 *   - Clean HTML produces no issues
 *   - Missing alt on <img> fires `image-alt`
 *   - Disabled rules (region, color-contrast) don't fire
 *   - Pre-publish + background both run; save-delta does not
 */
import { describe, it, expect } from 'vitest'
import type { Site } from '../src/site-loader.js'
import type { ContentRoot } from '../src/content-root.js'
import type { RenderedOutputAccess, SavedItem } from '../src/validation/types.js'
import { accessibility } from '../src/validation/validators/accessibility.js'

const site = {
  pages: new Map(),
  fragments: new Map(),
  pageLocales: new Map(),
  fragmentLocales: new Map(),
  manifest: { name: 't', targets: { local: {} } } as Site['manifest'],
  templatesDir: undefined,
} as Site

const stubRoot = { rootPath: '', join: () => '' } as unknown as ContentRoot
const stubStorage = {} as never

function renderedAs(html: string): RenderedOutputAccess {
  return { htmlFor: async () => html }
}

const item: SavedItem = { kind: 'page', name: 'home', itemPath: 'pages/home/page.json' }

describe('accessibility validator', () => {
  it('produces no issues on clean HTML', async () => {
    const html = `<!DOCTYPE html><html lang="en"><head><title>x</title></head><body><main><h1>x</h1><img src="a.jpg" alt="cat"></main></body></html>`
    const issues = await accessibility.validate({
      stage: 'background',
      site,
      contentRoot: stubRoot,
      storage: stubStorage,
      scope: { kind: 'background', item, manifest: { template: 't', content: {} } },
      renderedOutput: renderedAs(html),
    })
    expect(issues).toEqual([])
  })

  it('flags <img> without alt as image-alt violation', async () => {
    const html = `<!DOCTYPE html><html lang="en"><head><title>x</title></head><body><main><img src="a.jpg"></main></body></html>`
    const issues = await accessibility.validate({
      stage: 'background',
      site,
      contentRoot: stubRoot,
      storage: stubStorage,
      scope: { kind: 'background', item, manifest: { template: 't', content: {} } },
      renderedOutput: renderedAs(html),
    })
    expect(issues.some(i => i.message.includes('image-alt'))).toBe(true)
    const imgAlt = issues.find(i => i.message.includes('image-alt'))!
    expect(imgAlt.validator).toBe('accessibility')
    expect(imgAlt.severity).toBe('warn')
    expect(imgAlt.itemPath).toBe('pages/home/page.json')
  })

  it('does not fire disabled rules (region) on a missing-landmark page', async () => {
    const html = `<!DOCTYPE html><html lang="en"><head><title>x</title></head><body><p>just text</p></body></html>`
    const issues = await accessibility.validate({
      stage: 'background',
      site,
      contentRoot: stubRoot,
      storage: stubStorage,
      scope: { kind: 'background', item, manifest: { template: 't', content: {} } },
      renderedOutput: renderedAs(html),
    })
    expect(issues.some(i => i.message.includes('region'))).toBe(false)
    expect(issues.some(i => i.message.includes('landmark-one-main'))).toBe(false)
  })

  it('returns no issues when renderedOutput is absent', async () => {
    const issues = await accessibility.validate({
      stage: 'background',
      site,
      contentRoot: stubRoot,
      storage: stubStorage,
      scope: { kind: 'background', item, manifest: { template: 't', content: {} } },
    })
    expect(issues).toEqual([])
  })

  it('does not run on save-delta scope', async () => {
    const html = `<html lang="en"><body><img></body></html>`
    const issues = await accessibility.validate({
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

  it('runs on pre-publish scope', async () => {
    const html = `<!DOCTYPE html><html lang="en"><head><title>x</title></head><body><main><img src="a.jpg"></main></body></html>`
    const issues = await accessibility.validate({
      stage: 'pre-publish',
      site,
      contentRoot: stubRoot,
      storage: stubStorage,
      scope: { kind: 'pre-publish', items: [item] },
      renderedOutput: renderedAs(html),
    })
    expect(issues.length).toBeGreaterThan(0)
  })
})
