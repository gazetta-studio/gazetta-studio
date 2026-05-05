/**
 * Cut 3 tests: config loader integration tests with fixture configs.
 *
 * Validates loader behavior end-to-end using real jiti evaluation
 * against fixture site.config.ts and gazetta.config.ts files.
 *
 * Per design-config-implementation.md Cut 3 + Q2 lock:
 * - flat single-site layout
 * - multi-site layout
 * - flat + sites/ conflict → ConfigLayoutError
 * - empty sites/ → warning + empty result
 * - site directory without site.config.ts → warning + skip
 * - gazetta.config.ts defaults flow into site configs
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConfigEvaluationError, ConfigLayoutError, ConfigValidationError } from '../src/config/errors.js'
import { discoverSites, loadGazettaConfig, loadProjectConfig, loadSiteConfig } from '../src/config/loader.js'

const FIXTURES = join(__dirname, 'fixtures/configs')

describe('loadSiteConfig', () => {
  it('returns null when site.config.ts is missing', async () => {
    const result = await loadSiteConfig(join(FIXTURES, 'site-without-config/sites/incomplete'))
    expect(result).toBeNull()
  })

  it('loads + validates a valid site.config.ts', async () => {
    const result = await loadSiteConfig(join(FIXTURES, 'flat-single-site'))
    expect(result).not.toBeNull()
    expect(result?.config.name).toBe('flat-site')
    expect(result?.config.locale).toBe('en')
    expect(result?.configPath).toMatch(/site\.config\.ts$/)
  })
})

describe('loadGazettaConfig', () => {
  it('returns null when gazetta.config.ts is missing', async () => {
    const result = await loadGazettaConfig(join(FIXTURES, 'flat-single-site'))
    expect(result).toBeNull()
  })

  it('loads + validates a gazetta.config.ts', async () => {
    const result = await loadGazettaConfig(join(FIXTURES, 'with-global'))
    expect(result).not.toBeNull()
    expect(result?.logLevel).toBe('info')
    // defaults.cache is a constructed AdminCache instance (Path X). Per
    // single-Site-per-process, the gazetta-level cache is inherited
    // directly by the Site without per-Site reconstruction.
    const cache = result?.defaults?.cache as { get?: unknown; set?: unknown } | undefined
    expect(cache).toBeDefined()
    expect(typeof cache?.get).toBe('function')
    expect(typeof cache?.set).toBe('function')
    expect(result?.defaults?.audit).toEqual({ provider: 'history' })
  })
})

describe('discoverSites — flat layout', () => {
  it('returns single site at project root', async () => {
    const sites = await discoverSites(join(FIXTURES, 'flat-single-site'), null)
    expect(sites).toHaveLength(1)
    expect(sites[0].name).toBe('flat-site')
    expect(sites[0].dir).toMatch(/flat-single-site$/)
  })
})

describe('discoverSites — multi-site layout', () => {
  it('walks sites/ subdirectories in stable order', async () => {
    const sites = await discoverSites(join(FIXTURES, 'multi-site'), null)
    expect(sites).toHaveLength(2)
    // Sorted alphabetically: blog, main
    expect(sites[0].name).toBe('blog')
    expect(sites[1].name).toBe('main')
  })

  it('warns and skips a site directory without site.config.ts', async () => {
    const warnings: string[] = []
    const sites = await discoverSites(join(FIXTURES, 'site-without-config'), null, {
      logger: msg => warnings.push(msg),
    })
    expect(sites).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Skipping')
    expect(warnings[0]).toContain('incomplete')
  })

  it('warns and returns empty when sites/ is empty', async () => {
    const tmpDir = join(FIXTURES, '__tmp_empty_sites')
    rmSync(tmpDir, { recursive: true, force: true })
    mkdirSync(join(tmpDir, 'sites'), { recursive: true })
    try {
      const warnings: string[] = []
      const sites = await discoverSites(tmpDir, null, {
        logger: msg => warnings.push(msg),
      })
      expect(sites).toEqual([])
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('Empty sites/ directory')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('warns and returns empty when no site config and no sites/ dir exist', async () => {
    const tmpDir = join(FIXTURES, '__tmp_no_layout')
    rmSync(tmpDir, { recursive: true, force: true })
    mkdirSync(tmpDir, { recursive: true })
    try {
      const warnings: string[] = []
      const sites = await discoverSites(tmpDir, null, {
        logger: msg => warnings.push(msg),
      })
      expect(sites).toEqual([])
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('No site config found')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('discoverSites — conflict detection (Q2 lock)', () => {
  it('throws ConfigLayoutError when both flat and sites/ are present', async () => {
    await expect(discoverSites(join(FIXTURES, 'conflict-flat-and-sites'), null)).rejects.toThrow(ConfigLayoutError)
  })

  it('error message names both layouts so operator can fix', async () => {
    try {
      await discoverSites(join(FIXTURES, 'conflict-flat-and-sites'), null)
      throw new Error('expected ConfigLayoutError')
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigLayoutError)
      const msg = (err as Error).message
      expect(msg).toContain('site.config.ts')
      expect(msg).toContain('sites/')
    }
  })
})

describe('discoverSites — defaults flow', () => {
  it('inherits gazetta.config.defaults into site configs', async () => {
    const gazetta = await loadGazettaConfig(join(FIXTURES, 'with-global'))
    const sites = await discoverSites(join(FIXTURES, 'with-global'), gazetta)
    expect(sites).toHaveLength(1)
    const site = sites[0]
    // Site didn't set its own cache; inherits the gazetta-level
    // constructed AdminCache instance directly (Path X — single-Site-
    // per-process invariant in CONTEXT.md).
    expect(site.config.cache).toBeDefined()
    const cache = site.config.cache as { get?: unknown; set?: unknown; invalidate?: unknown } | undefined
    expect(typeof cache?.get).toBe('function')
    expect(typeof cache?.set).toBe('function')
    expect(typeof cache?.invalidate).toBe('function')
    // Audit defaults still flow through `admin.audit` (audit foundation
    // hasn't migrated to Path X yet).
    expect(site.config.admin?.audit).toEqual({ provider: 'history' })
  })

  it('Site inherits the gazetta-level cache instance by reference (single-Site-per-process)', async () => {
    const gazetta = await loadGazettaConfig(join(FIXTURES, 'with-global'))
    const sites = await discoverSites(join(FIXTURES, 'with-global'), gazetta)
    // The Site receives the same instance the gazetta-level config
    // produced — no per-Site reconstruction. Each process re-evaluates
    // `gazetta.config.ts` separately and gets its own fresh instance.
    expect(sites[0].config.cache).toBe(gazetta?.defaults?.cache)
  })
})

describe('loadProjectConfig — top-level entry point', () => {
  it('loads gazetta config + sites in one call', async () => {
    const result = await loadProjectConfig(join(FIXTURES, 'with-global'))
    expect(result.gazetta?.logLevel).toBe('info')
    expect(result.sites).toHaveLength(1)
    expect(result.sites[0].name).toBe('main')
    // Defaults applied: site inherits the gazetta-level cache instance.
    expect(result.sites[0].config.cache).toBeDefined()
    const cache = result.sites[0].config.cache as { get?: unknown } | undefined
    expect(typeof cache?.get).toBe('function')
  })

  it('handles flat layout without gazetta config', async () => {
    const result = await loadProjectConfig(join(FIXTURES, 'flat-single-site'))
    expect(result.gazetta).toBeNull()
    expect(result.sites).toHaveLength(1)
    expect(result.sites[0].name).toBe('flat-site')
  })

  it('returns absolute project root path', async () => {
    const result = await loadProjectConfig(join(FIXTURES, 'flat-single-site'))
    expect(result.projectRoot).toBe(join(FIXTURES, 'flat-single-site'))
  })
})

// ---- Dynamic-fixture tests for ConfigEvaluationError + ConfigValidationError ----

describe('error surfaces', () => {
  const tmp = join(FIXTURES, '__tmp_errors')

  beforeAll(() => {
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(tmp, { recursive: true })
  })

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('throws ConfigEvaluationError on syntax error', async () => {
    const dir = join(tmp, 'syntax-error')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'site.config.ts'), 'export default { name: "x" syntax error here }')
    await expect(loadSiteConfig(dir)).rejects.toThrow(ConfigEvaluationError)
  })

  it('throws when default export is missing (validation surfaces the missing-name)', async () => {
    // jiti returns the namespace object when no default export exists.
    // The missing `name` field then trips Zod validation — surfaces as
    // ConfigValidationError, not ConfigEvaluationError. Either signals
    // operator error clearly; both are acceptable outcomes.
    const dir = join(tmp, 'no-default')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'site.config.ts'), 'export const someOtherExport = { name: "x" }')
    await expect(loadSiteConfig(dir)).rejects.toThrow(ConfigValidationError)
  })

  it('throws ConfigValidationError when site name is missing', async () => {
    const dir = join(tmp, 'invalid-shape')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'site.config.ts'), `export default { locale: 'en' }`)
    await expect(loadSiteConfig(dir)).rejects.toThrow(ConfigValidationError)
  })

  it('ConfigValidationError carries file path', async () => {
    const dir = join(tmp, 'invalid-with-path')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'site.config.ts'), `export default { locale: 'en' }`)
    try {
      await loadSiteConfig(dir)
      throw new Error('expected ConfigValidationError')
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError)
      expect((err as ConfigValidationError).filePath).toMatch(/site\.config\.ts$/)
    }
  })
})
