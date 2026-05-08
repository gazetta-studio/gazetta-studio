/**
 * Unit tests for the html-validity validator.
 *
 * Feeds pre-rendered HTML strings via a stub `RenderedOutputAccess` so the
 * test surface is just the validator's parsing + reporting path.
 */
import { describe, it, expect } from 'vitest'
import type { Site } from '../src/site-loader.js'
import type { ContentRoot } from '../src/content-root.js'
import type { RenderedOutputAccess, SavedItem } from '../src/validation/types.js'
import { htmlValidity } from '../src/validation/validators/html-validity.js'

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

describe('html-validity validator', () => {
  it('emits no issues on valid HTML', async () => {
    const html = `<!DOCTYPE html><html lang="en"><head><title>x</title></head><body><img src="a" alt="cat"></body></html>`
    const issues = await htmlValidity.validate({
      stage: 'background',
      site,
      contentRoot: stubRoot,
      storage: stubStorage,
      scope: { kind: 'background', item, manifest: { template: 't', content: {} } },
      renderedOutput: renderedAs(html),
    })
    expect(issues).toEqual([])
  })

  it('flags missing alt on <img>', async () => {
    const html = `<!DOCTYPE html><html lang="en"><head><title>x</title></head><body><img src="a"></body></html>`
    const issues = await htmlValidity.validate({
      stage: 'background',
      site,
      contentRoot: stubRoot,
      storage: stubStorage,
      scope: { kind: 'background', item, manifest: { template: 't', content: {} } },
      renderedOutput: renderedAs(html),
    })
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.some(i => i.message.includes('alt'))).toBe(true)
    expect(issues[0].validator).toBe('html-validity')
    expect(issues[0].itemPath).toBe('pages/home/page.json')
  })

  it('flags missing lang attribute on <html>', async () => {
    const html = `<!DOCTYPE html><html><head><title>x</title></head><body></body></html>`
    const issues = await htmlValidity.validate({
      stage: 'background',
      site,
      contentRoot: stubRoot,
      storage: stubStorage,
      scope: { kind: 'background', item, manifest: { template: 't', content: {} } },
      renderedOutput: renderedAs(html),
    })
    expect(issues.some(i => i.message.includes('lang'))).toBe(true)
  })

  it('returns no issues when renderedOutput is absent', async () => {
    const issues = await htmlValidity.validate({
      stage: 'background',
      site,
      contentRoot: stubRoot,
      storage: stubStorage,
      scope: { kind: 'background', item, manifest: { template: 't', content: {} } },
      // no renderedOutput
    })
    expect(issues).toEqual([])
  })

  it('does not run on save-delta scope', async () => {
    const issues = await htmlValidity.validate({
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
      renderedOutput: renderedAs(`<html><body><img></body></html>`),
    })
    expect(issues).toEqual([])
  })

  it('promotes severity to error at pre-publish stage', async () => {
    const html = `<!DOCTYPE html><html lang="en"><head><title>x</title></head><body><img src="a"></body></html>`
    const issues = await htmlValidity.validate({
      stage: 'pre-publish',
      site,
      contentRoot: stubRoot,
      storage: stubStorage,
      scope: { kind: 'pre-publish', items: [item] },
      renderedOutput: renderedAs(html),
    })
    expect(issues.length).toBeGreaterThan(0)
    expect(issues[0].severity).toBe('error')
  })
})
