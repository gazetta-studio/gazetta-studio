/**
 * What a static page bakes in (sidecars.md "Target indices describe the
 * target"): every fragment it inlines, direct or nested, and every asset
 * the page or those fragments reference.
 */
import { describe, expect, it } from 'vitest'
import { resolveSiteLocales } from '../src/locale.js'
import type { Site } from '../src/site-loader.js'
import { flattenStaticPageDeps } from '../src/static-page-deps.js'

type Frag = { template?: string; archived?: boolean; aliasOf?: string; components?: unknown[]; content?: object }

function site(fragments: Record<string, Frag>, locales: Record<string, Record<string, Frag>> = {}): Site {
  const withDir = (f: Frag) => ({ ...f, dir: '' })
  return {
    manifest: { name: 's', locales: { default: 'en', supported: ['en', 'fr', 'fr-ca'] } },
    pages: new Map(),
    pageLocales: new Map(),
    fragments: new Map(Object.entries(fragments).map(([k, f]) => [k, withDir(f)])),
    fragmentLocales: new Map(
      Object.entries(locales).map(([k, byLocale]) => [
        k,
        {
          default: withDir(fragments[k] ?? {}),
          locales: new Map(Object.entries(byLocale).map(([l, f]) => [l, withDir(f)])),
        },
      ]),
    ),
  } as unknown as Site
}

const asset = (name: string) => ({ img: { _asset: name } })
const flatten = (s: Site, page: Frag, locale?: string) =>
  flattenStaticPageDeps(s, page, { locale, resolvedLocales: resolveSiteLocales(s.manifest) ?? undefined })
const sorted = (set: Set<string>) => [...set].sort()

describe('flattenStaticPageDeps', () => {
  it('collects nested fragments and the assets of the page and every baked fragment', () => {
    const s = site({
      header: { template: 'h', components: ['@logo', { template: 'nav', content: asset('nav-icon') }] },
      logo: { template: 'l', content: asset('logo-img') },
      footer: { template: 'f' },
    })
    const deps = flatten(s, { template: 'p', content: asset('hero'), components: ['@header', '@footer'] })
    expect(sorted(deps.fragments)).toEqual(['footer', 'header', 'logo'])
    expect(sorted(deps.assets)).toEqual(['hero', 'logo-img', 'nav-icon'])
  })

  it.each([
    ['the locale has its own variant', 'fr', ['fr-logo']],
    ['a regional locale falls back to its language', 'fr-ca', ['fr-logo']],
    ['the locale has none, so the default fragment is used', undefined, ['logo-img']],
  ])('follows the renderer locale fallback when %s', (_case, locale, assets) => {
    const s = site(
      { header: { template: 'h', components: ['@logo'] }, logo: { template: 'l', content: asset('logo-img') } },
      { logo: { fr: { template: 'l', content: asset('fr-logo') } } },
    )
    const deps = flatten(s, { template: 'p', components: ['@header'] }, locale)
    expect(sorted(deps.fragments)).toEqual(['header', 'logo'])
    expect(sorted(deps.assets)).toEqual(assets)
  })

  it('an archived fragment with aliasOf yields both names and walks the alias target', () => {
    const s = site({
      header: { archived: true, aliasOf: 'header2' },
      header2: { template: 'h', content: asset('h2-img'), components: ['@logo'] },
      logo: { template: 'l', content: asset('logo-img') },
    })
    const deps = flatten(s, { template: 'p', components: ['@header'] })
    expect(sorted(deps.fragments)).toEqual(['header', 'header2', 'logo'])
    expect(sorted(deps.assets)).toEqual(['h2-img', 'logo-img'])
  })

  it('circular references end the walk', () => {
    const s = site({ a: { template: 'x', components: ['@b'] }, b: { template: 'x', components: ['@a'] } })
    expect(sorted(flatten(s, { template: 'p', components: ['@a'] }).fragments)).toEqual(['a', 'b'])
  })

  it('a circular alias chain ends the walk', () => {
    const s = site({ a: { archived: true, aliasOf: 'b' }, b: { archived: true, aliasOf: 'a' } })
    expect(sorted(flatten(s, { template: 'p', components: ['@a'] }).fragments)).toEqual(['a', 'b'])
  })

  it('a missing fragment adds its referenced name only', () => {
    const s = site({})
    const deps = flatten(s, { template: 'p', components: ['@ghost'] })
    expect(sorted(deps.fragments)).toEqual(['ghost'])
    expect(deps.assets.size).toBe(0)
  })
})
