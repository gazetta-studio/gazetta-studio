/**
 * Structural test for the rule-15 extraction of `lookupManifest`.
 *
 * PR #461 added a third hand-rolled `lookupManifest` to the admin-API
 * routes (archive.ts, rename.ts, redirects.ts). Per
 * [team-preferences.md rule 15](../../.claude/rules/team-preferences.md):
 * "Extract shared code only when 3+ callers exist."
 * Threshold met. Pins the structural contract so a future regression
 * (someone adds a fourth inline copy, or removes the shared module and
 * re-inlines) fails CI.
 *
 * Per [team-preferences.md rule 40](../../.claude/rules/team-preferences.md):
 * structural tests are a legitimate TDD shape for non-behavior cuts.
 * The contract: assert N copies of `function lookupManifest` exist before
 * fix, 1 after fix; all three caller files import from the shared module.
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ADMIN_API_ROUTES_DIR = join(__dirname, '..', 'src', 'admin-api', 'routes')
const SHARED_MODULE_PATH = join(__dirname, '..', 'src', 'admin-api', 'lookup-manifest.ts')

async function readAllRouteFiles(): Promise<Array<{ name: string; content: string }>> {
  const names = await readdir(ADMIN_API_ROUTES_DIR)
  const tsFiles = names.filter(n => n.endsWith('.ts') && !n.endsWith('.test.ts'))
  return Promise.all(
    tsFiles.map(async name => ({
      name,
      content: await readFile(join(ADMIN_API_ROUTES_DIR, name), 'utf8'),
    })),
  )
}

describe('lookupManifest is extracted to a shared admin-api module', () => {
  it('shared module exports lookupManifest', async () => {
    const content = await readFile(SHARED_MODULE_PATH, 'utf8')
    expect(content).toMatch(/export function lookupManifest\b/)
  })

  it('no admin-api route file defines its own function lookupManifest', async () => {
    const files = await readAllRouteFiles()
    const offenders = files.filter(f => /^function lookupManifest\b/m.test(f.content))
    expect(offenders.map(o => o.name)).toEqual([])
  })

  it('archive.ts imports lookupManifest from the shared module', async () => {
    const content = await readFile(join(ADMIN_API_ROUTES_DIR, 'archive.ts'), 'utf8')
    expect(content).toMatch(/import\s*\{[^}]*\blookupManifest\b[^}]*\}\s*from\s*['"]\.\.\/lookup-manifest\.js['"]/)
  })

  it('rename.ts imports lookupManifest from the shared module', async () => {
    const content = await readFile(join(ADMIN_API_ROUTES_DIR, 'rename.ts'), 'utf8')
    expect(content).toMatch(/import\s*\{[^}]*\blookupManifest\b[^}]*\}\s*from\s*['"]\.\.\/lookup-manifest\.js['"]/)
  })

  it('redirects.ts imports lookupManifest from the shared module', async () => {
    const content = await readFile(join(ADMIN_API_ROUTES_DIR, 'redirects.ts'), 'utf8')
    expect(content).toMatch(/import\s*\{[^}]*\blookupManifest\b[^}]*\}\s*from\s*['"]\.\.\/lookup-manifest\.js['"]/)
  })
})

describe('lookupManifest shared module behavior', () => {
  it('returns the page manifest when kind is page', async () => {
    const mod = await import('../src/admin-api/lookup-manifest.js')
    const pageManifest = { template: 'home', content: {} }
    const fakeSite = {
      pages: new Map<string, unknown>([['home', pageManifest]]),
      fragments: new Map<string, unknown>(),
    }
    expect(mod.lookupManifest(fakeSite as never, 'page', 'home')).toBe(pageManifest)
  })

  it('returns the fragment manifest when kind is fragment', async () => {
    const mod = await import('../src/admin-api/lookup-manifest.js')
    const fragmentManifest = { template: 'layout', content: {} }
    const fakeSite = {
      pages: new Map<string, unknown>(),
      fragments: new Map<string, unknown>([['header', fragmentManifest]]),
    }
    expect(mod.lookupManifest(fakeSite as never, 'fragment', 'header')).toBe(fragmentManifest)
  })

  it('returns undefined when the name does not exist', async () => {
    const mod = await import('../src/admin-api/lookup-manifest.js')
    const fakeSite = {
      pages: new Map<string, unknown>(),
      fragments: new Map<string, unknown>(),
    }
    expect(mod.lookupManifest(fakeSite as never, 'page', 'missing')).toBeUndefined()
  })
})
