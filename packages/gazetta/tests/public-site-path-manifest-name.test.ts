/**
 * isManifestFileName: the reserved manifest names (design-public-storage.md
 * Q4), checked without a backtracking regular expression.
 */
import { describe, expect, it } from 'vitest'
import { isManifestFileName } from '../src/public-site-path.js'

describe('isManifestFileName', () => {
  it.each([
    'page.json',
    'page.fr.json',
    'PAGE.JSON',
    'fragment.json',
    'fragment.foo.bar.json',
    'hero.asset.json',
    'hero.asset.fr.json',
    'hero.asset.fr.dark.json',
    'a.b.asset.json',
    'x.asset.asset.json',
    'Hero.Asset.JSON',
  ])('reserves %s', name => {
    expect(isManifestFileName(name)).toBe(true)
  })

  it.each([
    'index.html',
    'page.json.bak',
    'page..json',
    'pages.json',
    'mypage.json',
    'fragment..json',
    '.asset.json',
    'hero.asset..json',
    'hero.assets.json',
    'hero.asset',
    'dir/page.json',
    'feed.json',
  ])('does not reserve %s', name => {
    expect(isManifestFileName(name)).toBe(false)
  })

  it('answers quickly on names repeating "..asset."', () => {
    const name = `${'..asset.'.repeat(50_000)}x`
    const start = performance.now()
    expect(isManifestFileName(name)).toBe(false)
    expect(performance.now() - start).toBeLessThan(500)
  })
})
