import { describe, expect, it } from 'vitest'
import { lookupManifest } from '../src/admin-api/lookup-manifest.js'

describe('lookupManifest (rule 15 — 3-caller extraction)', () => {
  it('returns the page when kind is "page"', () => {
    const pageManifest = { template: 'hero' } as never
    const site = {
      pages: new Map([['home', pageManifest]]),
      fragments: new Map(),
    } as never

    expect(lookupManifest(site, 'page', 'home')).toBe(pageManifest)
    expect(lookupManifest(site, 'page', 'missing')).toBeUndefined()
  })

  it('returns the fragment when kind is "fragment"', () => {
    const fragmentManifest = { template: 'header' } as never
    const site = {
      pages: new Map(),
      fragments: new Map([['header', fragmentManifest]]),
    } as never

    expect(lookupManifest(site, 'fragment', 'header')).toBe(fragmentManifest)
    expect(lookupManifest(site, 'fragment', 'missing')).toBeUndefined()
  })
})
