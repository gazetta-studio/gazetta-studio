/**
 * Removing a published item deletes the item's own files only
 * (design-publish-undo.md Q4): nested items' folders, other
 * translations and unrelated files stay.
 */
import { describe, expect, it } from 'vitest'
import { manifestPathsToRemove, removeItemFromTarget, type RemovalContext } from '../src/publish-remove.js'
import { memoryStorage } from './_helpers/memory-storage.js'

const esi: RemovalContext = { targetType: 'dynamic', locales: ['en', 'fr'], defaultLocale: 'en' }
const staticCtx: RemovalContext = { targetType: 'static', locales: ['en', 'fr'], defaultLocale: 'en' }

const aboutFolder = {
  'pages/about/page.json': '{}',
  'pages/about/page.fr.json': '{}',
  'pages/about/index.html': '<html>',
  'pages/about/index.fr.html': '<html fr>',
  'pages/about/styles.abcd1234.css': 'css',
  'pages/about/.cf120e4b.hash': '',
  'pages/about/.cf120e4b.hash.fr': '',
  'pages/about/.pub-20260417T220000Z': '',
  'pages/about/.pub-20260417T220000Z.fr': '',
  'pages/about/team/page.json': '{}',
  'pages/about/team/index.html': '<team>',
  'pages/about/team/.11112222.hash': '',
}

function seeded(extra: Record<string, string> = {}) {
  const storage = memoryStorage()
  storage.seed({ ...aboutFolder, ...extra })
  return storage
}

describe('removeItemFromTarget', () => {
  it('removes every file in an ESI page folder and keeps the nested page', async () => {
    const storage = seeded()
    const result = await removeItemFromTarget(storage, { kind: 'page', name: 'about' }, esi)
    expect(result).toEqual({ ok: true, filesRemoved: 9 })
    expect([...storage.dump().keys()].sort()).toEqual([
      'pages/about/team/.11112222.hash',
      'pages/about/team/index.html',
      'pages/about/team/page.json',
    ])
  })

  it('on a static target removes the route output and its translations, keeping nested routes', async () => {
    const storage = seeded({
      'about/index.html': '<about>',
      'fr/about/index.html': '<about fr>',
      'about/team/index.html': '<team>',
      'en/about/index.html': '<a page named en/about>',
    })
    const result = await removeItemFromTarget(storage, { kind: 'page', name: 'about' }, staticCtx)
    expect(result.ok).toBe(true)
    expect(await storage.exists('about/index.html')).toBe(false)
    expect(await storage.exists('fr/about/index.html')).toBe(false)
    expect(await storage.exists('about/team/index.html')).toBe(true)
    // The default locale is published unprefixed, so `en/about` is another page.
    expect(await storage.exists('en/about/index.html')).toBe(true)
    expect(await storage.exists('pages/about/team/page.json')).toBe(true)
  })

  it.each([
    ['dynamic', esi, 'pages/about/index.fr.html'],
    ['static', staticCtx, 'fr/about/index.html'],
  ] as const)('removing one translation on a %s target keeps the default version', async (_t, ctx, frOutput) => {
    const storage = seeded({ 'fr/about/index.html': '<about fr>', 'about/index.html': '<about>' })
    const result = await removeItemFromTarget(storage, { kind: 'page', name: 'about', locale: 'fr' }, ctx)
    expect(result.ok).toBe(true)
    for (const gone of [
      'pages/about/page.fr.json',
      frOutput,
      'pages/about/.cf120e4b.hash.fr',
      'pages/about/.pub-20260417T220000Z.fr',
    ]) {
      expect(await storage.exists(gone)).toBe(false)
    }
    for (const kept of [
      'pages/about/page.json',
      'pages/about/index.html',
      'pages/about/styles.abcd1234.css',
      'pages/about/.cf120e4b.hash',
      'pages/about/.pub-20260417T220000Z',
    ]) {
      expect(await storage.exists(kept)).toBe(true)
    }
  })

  it('deletes the static output at an explicit route instead of the derived one', async () => {
    const storage = seeded({ 'old-about/index.html': '<old>', 'about/index.html': '<new>' })
    await removeItemFromTarget(storage, { kind: 'page', name: 'about', route: '/old-about' }, staticCtx)
    expect(await storage.exists('old-about/index.html')).toBe(false)
    expect(await storage.exists('about/index.html')).toBe(true)
  })

  it('succeeds when the files are already gone', async () => {
    const storage = memoryStorage()
    expect(await removeItemFromTarget(storage, { kind: 'page', name: 'about' }, staticCtx)).toEqual({
      ok: true,
      filesRemoved: 0,
    })
    const again = seeded()
    await removeItemFromTarget(again, { kind: 'page', name: 'about' }, esi)
    expect(await removeItemFromTarget(again, { kind: 'page', name: 'about' }, esi)).toEqual({
      ok: true,
      filesRemoved: 0,
    })
  })

  it.each([
    { kind: 'page', name: 'about', locale: '../x' },
    { kind: 'page', name: '../pages/about' },
    { kind: 'page', name: 'about/..' },
    { kind: 'fragment', name: '' },
    { kind: 'page', name: 'about\\..\\x' },
    { kind: 'page', name: 'about', route: 'about' },
    { kind: 'page', name: 'about', route: '' },
    { kind: 'page', name: 'about', route: '/./about' },
    { kind: 'page', name: 'about', route: '/about\\..\\x' },
  ] as const)('rejects %o without deleting anything', async ref => {
    const storage = seeded()
    const before = [...storage.dump().keys()].length
    const result = await removeItemFromTarget(storage, ref, esi)
    expect(result.ok).toBe(false)
    expect([...storage.dump().keys()]).toHaveLength(before)
  })

  it('removes only the fragment folder files', async () => {
    const storage = seeded({
      'fragments/header/fragment.json': '{}',
      'fragments/header/index.html': '<h>',
      'fragments/header/.aaaabbbb.hash': '',
      'fragments/header/logo/fragment.json': '{}',
      'header/index.html': '<not the fragment>',
    })
    const result = await removeItemFromTarget(storage, { kind: 'fragment', name: 'header' }, staticCtx)
    expect(result).toEqual({ ok: true, filesRemoved: 3 })
    expect(await storage.exists('fragments/header/logo/fragment.json')).toBe(true)
    expect(await storage.exists('header/index.html')).toBe(true)
    expect(await storage.exists('pages/about/page.json')).toBe(true)
  })

  it("deletes the removed item's dependency edges and forward records, and keeps the rest", async () => {
    const storage = seeded({
      '.gazetta/fragment-deps/header/pages.about': '',
      '.gazetta/deps-of/fragment-deps/pages.about': '["header"]',
      '.gazetta/fragment-deps/header/pages.about:fr': '',
      '.gazetta/deps-of/fragment-deps/pages.about:fr': '["header"]',
      '.gazetta/asset-refs/hero/pages.about': '',
      '.gazetta/deps-of/asset-refs/pages.about': '["hero"]',
      '.gazetta/fragment-deps/header/pages.about.team': '',
      '.gazetta/deps-of/fragment-deps/pages.about.team': '["header"]',
    })
    expect((await removeItemFromTarget(storage, { kind: 'page', name: 'about' }, esi)).ok).toBe(true)
    for (const path of [
      '.gazetta/fragment-deps/header/pages.about',
      '.gazetta/deps-of/fragment-deps/pages.about',
      '.gazetta/fragment-deps/header/pages.about:fr',
      '.gazetta/deps-of/fragment-deps/pages.about:fr',
      '.gazetta/asset-refs/hero/pages.about',
      '.gazetta/deps-of/asset-refs/pages.about',
    ]) {
      expect(await storage.exists(path)).toBe(false)
    }
    expect(await storage.exists('.gazetta/fragment-deps/header/pages.about.team')).toBe(true)
    expect(await storage.exists('.gazetta/deps-of/fragment-deps/pages.about.team')).toBe(true)
  })

  it("removing a translation deletes only that translation's dependency records", async () => {
    const storage = seeded({
      '.gazetta/fragment-deps/header/pages.about': '',
      '.gazetta/deps-of/fragment-deps/pages.about': '["header"]',
      '.gazetta/fragment-deps/header/pages.about:fr': '',
      '.gazetta/deps-of/fragment-deps/pages.about:fr': '["header"]',
    })
    expect((await removeItemFromTarget(storage, { kind: 'page', name: 'about', locale: 'fr' }, esi)).ok).toBe(true)
    expect(await storage.exists('.gazetta/deps-of/fragment-deps/pages.about:fr')).toBe(false)
    expect(await storage.exists('.gazetta/fragment-deps/header/pages.about:fr')).toBe(false)
    expect(await storage.exists('.gazetta/deps-of/fragment-deps/pages.about')).toBe(true)
    expect(await storage.exists('.gazetta/fragment-deps/header/pages.about')).toBe(true)
  })

  it('reports a folder listing that fails instead of removing nothing', async () => {
    const storage = seeded()
    const failing = { ...storage, readDir: async () => Promise.reject(new Error('throttled')) }
    const result = await removeItemFromTarget(failing, { kind: 'page', name: 'about' }, esi)
    expect(result).toEqual({ ok: false, reason: 'storage delete failed: throttled' })
    expect(await storage.exists('pages/about/page.json')).toBe(true)
  })

  it('reports a failing storage delete', async () => {
    const storage = seeded()
    const failing = { ...storage, rm: async () => Promise.reject(new Error('denied')) }
    const result = await removeItemFromTarget(failing, { kind: 'page', name: 'about' }, esi)
    expect(result).toEqual({ ok: false, reason: 'storage delete failed: denied' })
  })
})

describe('manifestPathsToRemove', () => {
  it('lists every manifest in the folder for a bare item, and one variant for a locale ref', async () => {
    const storage = seeded()
    expect((await manifestPathsToRemove(storage, { kind: 'page', name: 'about' })).sort()).toEqual([
      'pages/about/page.fr.json',
      'pages/about/page.json',
    ])
    expect(await manifestPathsToRemove(storage, { kind: 'page', name: 'about', locale: 'fr' })).toEqual([
      'pages/about/page.fr.json',
    ])
    expect(await manifestPathsToRemove(storage, { kind: 'page', name: 'about', locale: 'de' })).toEqual([])
  })
})
