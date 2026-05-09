import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { resolveFragment, resolvePage } from '../src/resolver.js'
import { loadSite } from '../src/site-loader.js'
import { tempDir } from './_helpers/temp.js'

const testDir = tempDir('resolver-test')
const storage = createFilesystemProvider()

async function writeSite(files: Record<string, string>) {
  await rm(testDir, { recursive: true, force: true })
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(testDir, path)
    await mkdir(join(fullPath, '..'), { recursive: true })
    await writeFile(fullPath, content)
  }
}

async function writeTemplate(name: string) {
  const dir = join(testDir, 'templates', name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'index.ts'),
    `
import { z } from 'zod'
export const schema = z.object({ text: z.string().optional() })
export default ({ content, children }) => ({
  html: '<div>' + (content?.text ?? '') + (children ?? []).map(c => c.html).join('') + '</div>',
  css: '',
  js: '',
})
`,
  )
}

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('resolvePage', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('resolves a simple page with inline components', async () => {
    await writeSite({
      'pages/home/page.json': JSON.stringify({
        template: 'echo',
        components: [{ name: 'hero', template: 'echo', content: { text: 'Hello' } }],
      }),
    })
    await writeTemplate('echo')

    const site = await loadSite({ siteDir: testDir, storage, manifest: { name: 'Test' } })
    const resolved = await resolvePage('home', site)

    expect(resolved.children).toHaveLength(1)
    expect(resolved.children[0].content?.text).toBe('Hello')
  })

  it('resolves a page with fragment references', async () => {
    await writeSite({
      'fragments/header/fragment.json': JSON.stringify({ template: 'echo', content: { text: 'Header' } }),
      'pages/home/page.json': JSON.stringify({
        template: 'echo',
        components: ['@header'],
      }),
    })
    await writeTemplate('echo')

    const site = await loadSite({ siteDir: testDir, storage, manifest: { name: 'Test' } })
    const resolved = await resolvePage('home', site)

    expect(resolved.children).toHaveLength(1)
    expect(resolved.children[0].content?.text).toBe('Header')
  })

  it('resolves nested fragment with children', async () => {
    await writeSite({
      'fragments/header/fragment.json': JSON.stringify({
        template: 'echo',
        components: [{ name: 'logo', template: 'echo', content: { text: 'Logo' } }],
      }),
      'pages/home/page.json': JSON.stringify({
        template: 'echo',
        components: ['@header'],
      }),
    })
    await writeTemplate('echo')

    const site = await loadSite({ siteDir: testDir, storage, manifest: { name: 'Test' } })
    const resolved = await resolvePage('home', site)

    expect(resolved.children).toHaveLength(1)
    const header = resolved.children[0]
    expect(header.children).toHaveLength(1)
    expect(header.children[0].content?.text).toBe('Logo')
  })

  it('resolves deeply nested components', async () => {
    await writeSite({
      'pages/home/page.json': JSON.stringify({
        template: 'echo',
        components: [
          {
            name: 'features',
            template: 'echo',
            components: [
              { name: 'fast', template: 'echo', content: { text: 'Fast' } },
              { name: 'composable', template: 'echo', content: { text: 'Composable' } },
            ],
          },
        ],
      }),
    })
    await writeTemplate('echo')

    const site = await loadSite({ siteDir: testDir, storage, manifest: { name: 'Test' } })
    const resolved = await resolvePage('home', site)

    const features = resolved.children[0]
    expect(features.children).toHaveLength(2)
    expect(features.children[0].content?.text).toBe('Fast')
    expect(features.children[1].content?.text).toBe('Composable')
  })

  it('throws on missing page', async () => {
    await writeSite({})
    await mkdir(testDir, { recursive: true })
    const site = await loadSite({ siteDir: testDir, storage, manifest: { name: 'Test' } })
    await expect(resolvePage('nope', site)).rejects.toThrow('Page "nope" not found')
  })

  it('throws on missing fragment', async () => {
    await writeSite({
      'pages/home/page.json': JSON.stringify({
        template: 'echo',
        components: ['@missing'],
      }),
    })
    await writeTemplate('echo')

    const site = await loadSite({ siteDir: testDir, storage, manifest: { name: 'Test' } })
    await expect(resolvePage('home', site)).rejects.toThrow('Fragment "@missing" not found')
  })

  it('throws on string entry that is not a fragment reference', async () => {
    await writeSite({
      'pages/home/page.json': JSON.stringify({
        template: 'echo',
        components: ['not-a-fragment'],
      }),
    })
    await writeTemplate('echo')

    const site = await loadSite({ siteDir: testDir, storage, manifest: { name: 'Test' } })
    await expect(resolvePage('home', site)).rejects.toThrow('string entries must be fragment references')
  })

  it('throws on missing template', async () => {
    await writeSite({
      'pages/home/page.json': JSON.stringify({ template: 'nonexistent' }),
    })

    const site = await loadSite({ siteDir: testDir, storage, manifest: { name: 'Test' } })
    await expect(resolvePage('home', site)).rejects.toThrow('Template "nonexistent" not found')
  })

  it('lists available fragments on missing fragment error', async () => {
    await writeSite({
      'fragments/header/fragment.json': JSON.stringify({ template: 'echo' }),
      'fragments/footer/fragment.json': JSON.stringify({ template: 'echo' }),
      'pages/home/page.json': JSON.stringify({
        template: 'echo',
        components: ['@missing'],
      }),
    })
    await writeTemplate('echo')

    const site = await loadSite({ siteDir: testDir, storage, manifest: { name: 'Test' } })
    try {
      await resolvePage('home', site)
      expect.fail('should have thrown')
    } catch (err) {
      const message = (err as Error).message
      expect(message).toContain('header')
      expect(message).toContain('footer')
    }
  })

  it('sets treePath on resolved components', async () => {
    await writeSite({
      'pages/home/page.json': JSON.stringify({
        template: 'echo',
        components: [
          {
            name: 'features',
            template: 'echo',
            components: [{ name: 'fast', template: 'echo', content: { text: 'Fast' } }],
          },
        ],
      }),
    })
    await writeTemplate('echo')

    const site = await loadSite({ siteDir: testDir, storage, manifest: { name: 'Test' } })
    const resolved = await resolvePage('home', site)

    expect(resolved.treePath).toBe('')
    expect(resolved.children[0].treePath).toBe('features')
    expect(resolved.children[0].children[0].treePath).toBe('features/fast')
  })
})

describe('resolveFragment', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('resolves a simple fragment', async () => {
    await writeSite({
      'fragments/header/fragment.json': JSON.stringify({ template: 'echo', content: { text: 'Header' } }),
    })
    await writeTemplate('echo')

    const site = await loadSite({ siteDir: testDir, storage, manifest: { name: 'Test' } })
    const resolved = await resolveFragment('header', site)

    expect(resolved.content?.text).toBe('Header')
    expect(resolved.treePath).toBe('')
  })

  it('resolves a fragment with inline children', async () => {
    await writeSite({
      'fragments/header/fragment.json': JSON.stringify({
        template: 'echo',
        components: [{ name: 'logo', template: 'echo', content: { text: 'Logo' } }],
      }),
    })
    await writeTemplate('echo')

    const site = await loadSite({ siteDir: testDir, storage, manifest: { name: 'Test' } })
    const resolved = await resolveFragment('header', site)

    expect(resolved.children).toHaveLength(1)
    expect(resolved.children[0].content?.text).toBe('Logo')
    expect(resolved.children[0].treePath).toBe('@header/logo')
  })

  it('throws on missing fragment', async () => {
    await writeSite({})
    await mkdir(testDir, { recursive: true })
    const site = await loadSite({ siteDir: testDir, storage, manifest: { name: 'Test' } })
    await expect(resolveFragment('nope', site)).rejects.toThrow('Fragment "nope" not found')
  })

  it('lists available fragments on missing fragment error', async () => {
    await writeSite({
      'fragments/header/fragment.json': JSON.stringify({ template: 'echo' }),
      'fragments/footer/fragment.json': JSON.stringify({ template: 'echo' }),
    })
    await writeTemplate('echo')

    const site = await loadSite({ siteDir: testDir, storage, manifest: { name: 'Test' } })
    try {
      await resolveFragment('missing', site)
      expect.fail('should have thrown')
    } catch (err) {
      const message = (err as Error).message
      expect(message).toContain('header')
      expect(message).toContain('footer')
    }
  })
})

/**
 * Circular-reference detection — documented in operations.md
 * ("Fragment nesting: Circular references are detected and reported").
 * Runtime uses resolver.ts:33-38 + 72-76 to throw before an infinite
 * recursion can land. These tests cover the three shapes a cycle can
 * take in authored content.
 */
describe('circular reference detection', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('detects a direct self-reference (A → A)', async () => {
    // Fragment A lists itself — smallest possible cycle. Resolver must
    // bail at the second visit, not crash the process.
    await writeSite({
      'fragments/a/fragment.json': JSON.stringify({
        template: 'echo',
        components: ['@a'],
      }),
      'pages/home/page.json': JSON.stringify({
        template: 'echo',
        components: ['@a'],
      }),
    })
    await writeTemplate('echo')

    const site = await loadSite({ siteDir: testDir, storage, manifest: { name: 'Test' } })
    await expect(resolvePage('home', site)).rejects.toThrow(/[Cc]ircular reference/)
  })

  it('detects a two-fragment cycle (A → B → A)', async () => {
    // A references B, B references back to A. Resolver tracks visited
    // refs across recursion depth — both fragments are valid in isolation
    // but together form a cycle.
    await writeSite({
      'fragments/a/fragment.json': JSON.stringify({
        template: 'echo',
        components: ['@b'],
      }),
      'fragments/b/fragment.json': JSON.stringify({
        template: 'echo',
        components: ['@a'],
      }),
      'pages/home/page.json': JSON.stringify({
        template: 'echo',
        components: ['@a'],
      }),
    })
    await writeTemplate('echo')

    const site = await loadSite({ siteDir: testDir, storage, manifest: { name: 'Test' } })
    const err = await resolvePage('home', site).catch(e => e as Error)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('Circular reference')
    // The error message shows the resolution path so the author can
    // trace the cycle (resolver.ts:35-36).
    expect(err.message).toContain('@a')
    expect(err.message).toContain('@b')
  })

  it('detects a three-fragment cycle (A → B → C → A)', async () => {
    // Three-hop cycle — ensures the detector isn't just catching
    // depth-2 loops.
    await writeSite({
      'fragments/a/fragment.json': JSON.stringify({
        template: 'echo',
        components: ['@b'],
      }),
      'fragments/b/fragment.json': JSON.stringify({
        template: 'echo',
        components: ['@c'],
      }),
      'fragments/c/fragment.json': JSON.stringify({
        template: 'echo',
        components: ['@a'],
      }),
      'pages/home/page.json': JSON.stringify({
        template: 'echo',
        components: ['@a'],
      }),
    })
    await writeTemplate('echo')

    const site = await loadSite({ siteDir: testDir, storage, manifest: { name: 'Test' } })
    await expect(resolvePage('home', site)).rejects.toThrow(/[Cc]ircular reference/)
  })

  it('allows a diamond (A → B, A → C, both B and C → D) without false positives', async () => {
    // Diamond-shape dependency: D is referenced twice on independent
    // branches, but there is NO cycle. The visited-set is popped when
    // a branch completes (resolver.ts:45-46, 63-64, 89-90) — this test
    // ensures we don't regress to a broken visited-set that would
    // flag D as already-visited on the second branch.
    await writeSite({
      'fragments/a/fragment.json': JSON.stringify({
        template: 'echo',
        components: ['@b', '@c'],
      }),
      'fragments/b/fragment.json': JSON.stringify({
        template: 'echo',
        components: ['@d'],
      }),
      'fragments/c/fragment.json': JSON.stringify({
        template: 'echo',
        components: ['@d'],
      }),
      'fragments/d/fragment.json': JSON.stringify({
        template: 'echo',
        content: { text: 'leaf' },
      }),
      'pages/home/page.json': JSON.stringify({
        template: 'echo',
        components: ['@a'],
      }),
    })
    await writeTemplate('echo')

    const site = await loadSite({ siteDir: testDir, storage, manifest: { name: 'Test' } })
    // Should NOT throw — a diamond is not a cycle.
    const resolved = await resolvePage('home', site)
    expect(resolved.children).toHaveLength(1) // @a at the root
  })
})

// Soft-delete Cut 2: alias-aware fragment resolution per design-soft-delete.md Q2 F1.
//
// Archived fragments with `aliasOf` resolve transparently to the alias
// target. Archived fragments without `aliasOf` throw ArchivedNoAliasError,
// surfacing render-time errors that the worker layer (Cut 3) translates
// to 410 Gone or fail-fragment.
describe('archive-aware fragment resolution', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('resolves @oldname → @newname when oldname is archived with aliasOf', async () => {
    await writeSite({
      'pages/home/page.json': JSON.stringify({
        template: 'echo',
        components: ['@old-header'],
      }),
      'fragments/old-header/fragment.json': JSON.stringify({
        template: 'echo',
        archived: true,
        aliasOf: 'new-header',
        archivedAt: '2026-05-09T10:00:00Z',
        archivedBy: 'alice@example.com',
      }),
      'fragments/new-header/fragment.json': JSON.stringify({
        template: 'echo',
        content: { text: 'live header' },
      }),
    })
    await writeTemplate('echo')

    const site = await loadSite({ siteDir: testDir, storage, manifest: { name: 'Test' } })
    const resolved = await resolvePage('home', site)
    // The page composes the new fragment's content, transparently
    expect(resolved.children).toHaveLength(1)
    expect(resolved.children?.[0]?.content).toMatchObject({ text: 'live header' })
  })

  it('throws ArchivedNoAliasError when the referenced fragment is archived without aliasOf', async () => {
    await writeSite({
      'pages/home/page.json': JSON.stringify({
        template: 'echo',
        components: ['@dead-fragment'],
      }),
      'fragments/dead-fragment/fragment.json': JSON.stringify({
        template: 'echo',
        archived: true,
        archivedAt: '2026-05-09T10:00:00Z',
        archivedBy: 'alice@example.com',
        // no aliasOf — pure soft-delete
      }),
    })
    await writeTemplate('echo')

    const site = await loadSite({ siteDir: testDir, storage, manifest: { name: 'Test' } })
    await expect(resolvePage('home', site)).rejects.toThrow(/dead-fragment/)
    // Verify it's our typed error
    await expect(resolvePage('home', site)).rejects.toMatchObject({
      name: 'ArchivedNoAliasError',
      fragmentName: 'dead-fragment',
    })
  })

  it('resolves a live fragment normally when archive fields are absent', async () => {
    // Regression check: existing behavior unchanged for non-archived fragments.
    await writeSite({
      'pages/home/page.json': JSON.stringify({
        template: 'echo',
        components: ['@header'],
      }),
      'fragments/header/fragment.json': JSON.stringify({
        template: 'echo',
        content: { text: 'hi' },
      }),
    })
    await writeTemplate('echo')

    const site = await loadSite({ siteDir: testDir, storage, manifest: { name: 'Test' } })
    const resolved = await resolvePage('home', site)
    expect(resolved.children?.[0]?.content).toMatchObject({ text: 'hi' })
  })

  it('throws "Fragment not found" when alias target does not exist', async () => {
    await writeSite({
      'pages/home/page.json': JSON.stringify({
        template: 'echo',
        components: ['@old-header'],
      }),
      'fragments/old-header/fragment.json': JSON.stringify({
        template: 'echo',
        archived: true,
        aliasOf: 'never-existed',
      }),
    })
    await writeTemplate('echo')

    const site = await loadSite({ siteDir: testDir, storage, manifest: { name: 'Test' } })
    await expect(resolvePage('home', site)).rejects.toThrow(/not found/)
  })

  it('resolveFragment entry-point also follows aliases', async () => {
    // The entry-point used by preview / direct fragment renders.
    await writeSite({
      'fragments/old-header/fragment.json': JSON.stringify({
        template: 'echo',
        archived: true,
        aliasOf: 'new-header',
      }),
      'fragments/new-header/fragment.json': JSON.stringify({
        template: 'echo',
        content: { text: 'live' },
      }),
    })
    await writeTemplate('echo')

    const site = await loadSite({ siteDir: testDir, storage, manifest: { name: 'Test' } })
    const resolved = await resolveFragment('old-header', site)
    expect(resolved.content).toMatchObject({ text: 'live' })
  })
})
