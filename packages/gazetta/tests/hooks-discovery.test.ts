/**
 * Cut 3 tests: site-local hook discovery (admin/hooks/*.ts).
 *
 * Pinned invariants per design-hooks.md "Discovery (Q4 locked)":
 *   - Walks `admin/hooks/*.{ts,js,tsx,mjs}`
 *   - Missing directory → empty result, no error
 *   - One file may export multiple phase names (e.g., beforeSave +
 *     afterSave together)
 *   - Optional `meta` overrides name / priority / timeout
 *   - Site-local hooks default to priority 1000 (band convention)
 *   - File basename is the default name (without extension)
 *   - Bad meta shapes silently degrade to defaults; don't poison
 *     other hooks in the file
 *   - Failed imports surface in `result.errors` without preventing
 *     other files from registering
 *   - Files are visited in stable filesystem order (sorted by name)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverSiteLocalHooks, HookRegistry } from '../src/hooks/index.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hooks-discovery-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeHook(name: string, content: string) {
  writeFileSync(join(dir, name), content)
}

describe('Cut 3 — discoverSiteLocalHooks', () => {
  describe('missing / empty cases', () => {
    it('returns empty result when directory does not exist', async () => {
      const r = new HookRegistry()
      const result = await discoverSiteLocalHooks({
        hooksDir: join(dir, 'does-not-exist'),
        registry: r,
      })
      expect(result.filesScanned).toBe(0)
      expect(result.handlersRegistered).toBe(0)
      expect(result.errors).toHaveLength(0)
      expect(r.size()).toBe(0)
    })

    it('returns empty result when directory is empty', async () => {
      const r = new HookRegistry()
      const result = await discoverSiteLocalHooks({ hooksDir: dir, registry: r })
      expect(result.filesScanned).toBe(0)
      expect(result.handlersRegistered).toBe(0)
      expect(r.size()).toBe(0)
    })

    it('skips non-hook file extensions', async () => {
      writeHook('readme.md', '# notes')
      writeHook('meta.json', '{}')
      const r = new HookRegistry()
      const result = await discoverSiteLocalHooks({ hooksDir: dir, registry: r })
      expect(result.filesScanned).toBe(0)
      expect(result.handlersRegistered).toBe(0)
    })
  })

  describe('single-file registration', () => {
    it('registers one phase from a .ts file', async () => {
      writeHook('auto-slugify.ts', `export const beforeSave = async (scope, payload, ctx) => payload`)
      const r = new HookRegistry()
      const result = await discoverSiteLocalHooks({ hooksDir: dir, registry: r })
      expect(result.filesScanned).toBe(1)
      expect(result.handlersRegistered).toBe(1)
      expect(result.errors).toHaveLength(0)
      const regs = r.getByPhase('beforeSave')
      expect(regs).toHaveLength(1)
      expect(regs[0].name).toBe('auto-slugify')
      expect(regs[0].priority).toBe(1000) // site-local default
      expect(regs[0].timeout).toBe(5000) // registry default
      expect(regs[0].source).toBe('site-local')
    })

    it('registers .js files', async () => {
      writeHook('log-saves.js', `export const afterSave = async (scope, result, ctx) => {}`)
      const r = new HookRegistry()
      const result = await discoverSiteLocalHooks({ hooksDir: dir, registry: r })
      expect(result.handlersRegistered).toBe(1)
      expect(r.getByPhase('afterSave')).toHaveLength(1)
    })

    it('registers multiple phases from one file', async () => {
      writeHook(
        'cdn-purge.ts',
        `export const afterSave = async (scope, result, ctx) => {}
         export const afterPublish = async (target, result, ctx) => {}`,
      )
      const r = new HookRegistry()
      const result = await discoverSiteLocalHooks({ hooksDir: dir, registry: r })
      expect(result.filesScanned).toBe(1)
      expect(result.handlersRegistered).toBe(2)
      expect(r.getByPhase('afterSave')).toHaveLength(1)
      expect(r.getByPhase('afterPublish')).toHaveLength(1)
      // Both share the file's basename as default.
      expect(r.getByPhase('afterSave')[0].name).toBe('cdn-purge')
      expect(r.getByPhase('afterPublish')[0].name).toBe('cdn-purge')
    })

    it('ignores non-function exports that share a phase name', async () => {
      writeHook(
        'bogus.ts',
        `export const beforeSave = 'not a function'
         export const afterSave = async (s, r, c) => {}`,
      )
      const r = new HookRegistry()
      const result = await discoverSiteLocalHooks({ hooksDir: dir, registry: r })
      expect(result.handlersRegistered).toBe(1)
      expect(r.size('beforeSave')).toBe(0)
      expect(r.size('afterSave')).toBe(1)
    })
  })

  describe('meta overrides', () => {
    it('applies meta.name', async () => {
      writeHook(
        'a.ts',
        `export const meta = { name: 'custom-name' }
         export const beforeSave = async (s, p, c) => p`,
      )
      const r = new HookRegistry()
      await discoverSiteLocalHooks({ hooksDir: dir, registry: r })
      expect(r.getByPhase('beforeSave')[0].name).toBe('custom-name')
    })

    it('applies meta.priority', async () => {
      writeHook(
        'a.ts',
        `export const meta = { priority: 50 }
         export const beforeSave = async (s, p, c) => p`,
      )
      const r = new HookRegistry()
      await discoverSiteLocalHooks({ hooksDir: dir, registry: r })
      expect(r.getByPhase('beforeSave')[0].priority).toBe(50)
    })

    it('applies meta.timeout', async () => {
      writeHook(
        'a.ts',
        `export const meta = { timeout: 1000 }
         export const beforeSave = async (s, p, c) => p`,
      )
      const r = new HookRegistry()
      await discoverSiteLocalHooks({ hooksDir: dir, registry: r })
      expect(r.getByPhase('beforeSave')[0].timeout).toBe(1000)
    })

    it('silently degrades bad meta shape — handlers still register with defaults', async () => {
      writeHook(
        'a.ts',
        `export const meta = 'not an object'
         export const beforeSave = async (s, p, c) => p`,
      )
      const r = new HookRegistry()
      const result = await discoverSiteLocalHooks({ hooksDir: dir, registry: r })
      expect(result.handlersRegistered).toBe(1)
      expect(r.getByPhase('beforeSave')[0].priority).toBe(1000) // default
      expect(r.getByPhase('beforeSave')[0].name).toBe('a') // file basename
    })

    it('silently degrades partial bad meta — string priority ignored', async () => {
      writeHook(
        'a.ts',
        `export const meta = { name: 'good', priority: 'fifty' }
         export const beforeSave = async (s, p, c) => p`,
      )
      const r = new HookRegistry()
      await discoverSiteLocalHooks({ hooksDir: dir, registry: r })
      const reg = r.getByPhase('beforeSave')[0]
      expect(reg.name).toBe('good') // the valid field applied
      expect(reg.priority).toBe(1000) // bad priority ignored → default
    })

    it('rejects non-positive timeout (defaults applied)', async () => {
      writeHook(
        'a.ts',
        `export const meta = { timeout: -100 }
         export const beforeSave = async (s, p, c) => p`,
      )
      const r = new HookRegistry()
      await discoverSiteLocalHooks({ hooksDir: dir, registry: r })
      expect(r.getByPhase('beforeSave')[0].timeout).toBe(5000) // default
    })
  })

  describe('multi-file scenarios', () => {
    it('visits files in stable sorted order', async () => {
      // Filenames out of alphabetical order; expect alphabetical
      // order in the resulting registration sequence.
      writeHook('zebra.ts', `export const beforeSave = async (s, p, c) => p`)
      writeHook('apple.ts', `export const beforeSave = async (s, p, c) => p`)
      writeHook('mango.ts', `export const beforeSave = async (s, p, c) => p`)
      const r = new HookRegistry()
      await discoverSiteLocalHooks({ hooksDir: dir, registry: r })
      const names = r.getByPhase('beforeSave').map(reg => reg.name)
      // All same priority (1000); registration order = filesystem
      // sorted order (apple, mango, zebra).
      expect(names).toEqual(['apple', 'mango', 'zebra'])
    })

    it('one file failure does not prevent others from registering', async () => {
      writeHook('good.ts', `export const beforeSave = async (s, p, c) => p`)
      writeHook('broken.ts', `import 'this-package-does-not-exist'`)
      writeHook('good2.ts', `export const afterSave = async (s, r, c) => {}`)
      const r = new HookRegistry()
      const result = await discoverSiteLocalHooks({ hooksDir: dir, registry: r })
      expect(result.filesScanned).toBe(3)
      expect(result.handlersRegistered).toBe(2) // good + good2
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0].file).toBe('broken.ts')
    })
  })

  describe('subdirectories', () => {
    it('does not recurse — subdirs ignored in v1', async () => {
      writeHook('top.ts', `export const beforeSave = async (s, p, c) => p`)
      mkdirSync(join(dir, 'nested'))
      writeFileSync(join(dir, 'nested', 'inner.ts'), `export const beforeSave = async (s, p, c) => p`)
      const r = new HookRegistry()
      const result = await discoverSiteLocalHooks({ hooksDir: dir, registry: r })
      expect(result.filesScanned).toBe(1) // only top.ts
      expect(result.handlersRegistered).toBe(1)
    })
  })
})
