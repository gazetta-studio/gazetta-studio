/** #1755: `--render`'s three steps, each on its own. */
import { describe, expect, it } from 'vitest'
import { itemsToRender, templatesFromPaths } from '../src/cli/validate-render-check.js'
import { renderComponent, thrownByTemplate } from '../src/renderer.js'
import type { Site } from '../src/site-loader.js'
import { computeTemplateImpact } from '../src/validation/template-impact.js'

describe('templatesFromPaths', () => {
  it.each([
    [
      ['hero/index.tsx', 'hero/styles.css', 'card/index.ts'],
      ['card', 'hero'],
    ],
    [[], []],
  ])('%j → %j', (paths, names) => {
    const result = templatesFromPaths(paths)
    expect(result === 'all' ? 'all' : [...result].sort()).toEqual(names)
  })

  it.each([['_shared/format.ts'], ['tsconfig.json']])(
    'a change outside a template folder (%s) selects every template',
    path => {
      expect(templatesFromPaths(['hero/index.ts', path])).toBe('all')
    },
  )
})

// home bakes @header, which bakes @nav, which uses `logo`; about uses `hero` directly.
function site(): Site {
  const page = (name: string, components: unknown[]) => ({
    template: 'page-default',
    route: `/${name}`,
    dir: `pages/${name}`,
    components,
  })
  const fragment = (name: string, components: unknown[], template = 'layout') => ({
    template,
    dir: `fragments/${name}`,
    components,
  })
  return {
    pages: new Map([
      ['home', page('home', ['@header'])],
      ['about', page('about', [{ name: 'hero', template: 'hero', content: {} }])],
    ]),
    pageLocales: new Map(),
    fragments: new Map([
      ['header', fragment('header', ['@nav'])],
      ['nav', fragment('nav', [{ name: 'logo', template: 'logo', content: {} }])],
    ]),
    fragmentLocales: new Map(),
    manifest: { name: 't', targets: {} },
  } as unknown as Site
}

describe('computeTemplateImpact throughFragments', () => {
  const names = (opts?: { throughFragments?: boolean }) =>
    computeTemplateImpact(site(), 'logo', () => [], opts).items.map(i => `${i.kind}:${i.name}`)

  it('finds only direct users by default', () => {
    expect(names()).toEqual(['fragment:nav'])
  })

  it('adds every page and fragment that uses it through fragments, at any depth', () => {
    expect(names({ throughFragments: true })).toEqual(['page:home', 'fragment:header', 'fragment:nav'])
  })
})

describe('itemsToRender', () => {
  it('renders only the items using a selected template', () => {
    expect(itemsToRender(site(), new Set(['hero'])).map(i => i.itemPath)).toEqual(['pages/about/page.json'])
  })

  it('renders every item when every template is selected', () => {
    expect(itemsToRender(site(), 'all')).toHaveLength(4)
  })
})

describe('thrownByTemplate', () => {
  it('names the innermost template that threw, and leaves the error as it was', async () => {
    const ok = () => ({ html: '', css: '', js: '' })
    const tree = {
      template: ok,
      templateName: 'outer',
      children: [
        {
          template: () => {
            throw new Error('inner broke')
          },
          templateName: 'inner',
          children: [],
        },
      ],
    }
    const err = await renderComponent(tree as never).catch(e => e)
    expect(err.message).toBe('inner broke')
    expect(thrownByTemplate(err)).toBe('inner')
  })

  it('knows nothing about an error no template threw', () => {
    expect(thrownByTemplate(new Error('x'))).toBeUndefined()
    expect(thrownByTemplate('a string')).toBeUndefined()
  })
})
