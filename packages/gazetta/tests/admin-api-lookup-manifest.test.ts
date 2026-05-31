import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')
const routesDir = join(repoRoot, 'src', 'admin-api', 'routes')
const sharedModulePath = join(repoRoot, 'src', 'admin-api', 'lookup-manifest.ts')

const consumerRoutes = ['archive.ts', 'rename.ts', 'redirects.ts'] as const

describe('lookupManifest extraction (rule 15 — 3-caller threshold)', () => {
  it('defines lookupManifest exactly once in src/, in the shared module', async () => {
    const sharedSource = await readFile(sharedModulePath, 'utf8')
    const definitionCount = matchCount(sharedSource, /export\s+function\s+lookupManifest\s*\(/g)
    expect(definitionCount).toBe(1)

    for (const route of consumerRoutes) {
      const routeSource = await readFile(join(routesDir, route), 'utf8')
      const localDefs = matchCount(routeSource, /function\s+lookupManifest\s*\(/g)
      expect(localDefs, `${route} should not define lookupManifest locally`).toBe(0)
    }
  })

  it('all three route files import lookupManifest from the shared module', async () => {
    for (const route of consumerRoutes) {
      const routeSource = await readFile(join(routesDir, route), 'utf8')
      const hasImport = /import\s+\{[^}]*\blookupManifest\b[^}]*\}\s+from\s+['"][^'"]*lookup-manifest\.js['"]/.test(
        routeSource,
      )
      expect(hasImport, `${route} should import lookupManifest from lookup-manifest.js`).toBe(true)
    }
  })

  it('lookupManifest returns the page when kind is "page"', async () => {
    const { lookupManifest } = await import('../src/admin-api/lookup-manifest.js')
    const pageManifest = { template: 'hero', dir: '/pages/home' } as never
    const site = {
      pages: new Map([['home', pageManifest]]),
      fragments: new Map(),
    } as never

    expect(lookupManifest(site, 'page', 'home')).toBe(pageManifest)
    expect(lookupManifest(site, 'page', 'missing')).toBeUndefined()
  })

  it('lookupManifest returns the fragment when kind is "fragment"', async () => {
    const { lookupManifest } = await import('../src/admin-api/lookup-manifest.js')
    const fragmentManifest = { template: 'header', dir: '/fragments/header' } as never
    const site = {
      pages: new Map(),
      fragments: new Map([['header', fragmentManifest]]),
    } as never

    expect(lookupManifest(site, 'fragment', 'header')).toBe(fragmentManifest)
    expect(lookupManifest(site, 'fragment', 'missing')).toBeUndefined()
  })
})

function matchCount(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length
}
