import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const routesDir = join(__dirname, '..', 'src', 'admin-api', 'routes')

const consumerRoutes = ['archive.ts', 'rename.ts', 'redirects.ts'] as const

describe('lookupManifest (rule 15 — 3-caller extraction)', () => {
  it('has no inline `function lookupManifest` definitions in the three consumer routes', async () => {
    for (const route of consumerRoutes) {
      const source = await readFile(join(routesDir, route), 'utf8')
      const inline = [...source.matchAll(/function\s+lookupManifest\s*\(/g)].length
      expect(inline, `${route} should not define lookupManifest locally`).toBe(0)
    }
  })

  it('returns the page when kind is "page"', async () => {
    const { lookupManifest } = await import('../src/admin-api/lookup-manifest.js')
    const pageManifest = { template: 'hero' } as never
    const site = {
      pages: new Map([['home', pageManifest]]),
      fragments: new Map(),
    } as never

    expect(lookupManifest(site, 'page', 'home')).toBe(pageManifest)
    expect(lookupManifest(site, 'page', 'missing')).toBeUndefined()
  })

  it('returns the fragment when kind is "fragment"', async () => {
    const { lookupManifest } = await import('../src/admin-api/lookup-manifest.js')
    const fragmentManifest = { template: 'header' } as never
    const site = {
      pages: new Map(),
      fragments: new Map([['header', fragmentManifest]]),
    } as never

    expect(lookupManifest(site, 'fragment', 'header')).toBe(fragmentManifest)
    expect(lookupManifest(site, 'fragment', 'missing')).toBeUndefined()
  })
})
