/**
 * Cut 1 tests: types + Zod schemas + defineSite/defineGazetta identity functions.
 *
 * Validates:
 * - defineSite/defineGazetta preserve input via generic identity pattern
 * - Zod schemas accept valid configs
 * - Zod schemas reject invalid configs (missing name, bad locale, etc.)
 * - Error classes carry file path + cause
 *
 * Per design-config-implementation.md Cut 1: type-level checks +
 * schema parsing happy path + invalid config rejection.
 */

import { describe, it, expect } from 'vitest'
import { memoryCache } from '../src/cache/factories.js'
import { defineSite, defineGazetta } from '../src/config/define.js'
import { filesystemStorage } from '../src/providers/factories.js'
import { SiteConfigSchema, GazettaConfigSchema } from '../src/config/schemas.js'
import { ConfigError, ConfigValidationError, ConfigEvaluationError, ConfigLayoutError } from '../src/config/errors.js'

describe('defineSite identity function', () => {
  it('returns input unchanged', () => {
    const config = defineSite({ name: 'test' })
    expect(config).toEqual({ name: 'test' })
  })

  it('preserves nested structure', () => {
    const config = defineSite({
      name: 'main',
      locale: 'en',
      locales: { supported: ['en', 'fr'] },
      themes: { supported: ['light', 'dark'], default: 'light' },
      targets: {
        local: { storage: filesystemStorage({ path: './dist/local' }) },
      },
    })
    expect(config.targets?.local).toBeDefined()
    expect(config.themes?.supported).toEqual(['light', 'dark'])
  })

  it('preserves literal types via generic constraint', () => {
    // This is a type-level test — if it compiles, the generic preserves literals
    const config = defineSite({ name: 'literal-name' })
    // TS infers `'literal-name'` literal, not `string`
    const _typeCheck: 'literal-name' = config.name as 'literal-name'
    expect(_typeCheck).toBe('literal-name')
  })
})

describe('defineGazetta identity function', () => {
  it('returns empty config unchanged', () => {
    const config = defineGazetta({})
    expect(config).toEqual({})
  })

  it('returns full config unchanged', () => {
    const config = defineGazetta({
      logLevel: 'info',
      telemetry: false,
      dev: { port: 3000, hostname: 'localhost' },
      defaults: {
        // Path X — factory result. Single-Site-per-process invariant means
        // each process re-evaluates this and gets a fresh instance.
        cache: memoryCache({ maxEntries: 5000 }),
        audit: { provider: 'history' },
      },
      mcp: { enabled: true, port: 3100 },
    })
    expect(config.logLevel).toBe('info')
    expect(config.dev?.port).toBe(3000)
  })
})

describe('SiteConfigSchema validation', () => {
  it('accepts minimal valid config', () => {
    const result = SiteConfigSchema.safeParse({ name: 'main' })
    expect(result.success).toBe(true)
  })

  it('accepts config with locales', () => {
    const result = SiteConfigSchema.safeParse({
      name: 'main',
      locales: {
        default: 'en',
        supported: ['en', 'fr', 'pt-br'],
        defaultPrefix: false,
      },
    })
    expect(result.success).toBe(true)
  })

  it('accepts config with themes', () => {
    const result = SiteConfigSchema.safeParse({
      name: 'main',
      themes: { supported: ['light', 'dark'], default: 'light' },
    })
    expect(result.success).toBe(true)
  })

  it('accepts config with targets', () => {
    const result = SiteConfigSchema.safeParse({
      name: 'main',
      targets: {
        local: { storage: { type: 'filesystem' } },
        production: { storage: { type: 'r2', bucket: 'site-prod' } },
      },
    })
    expect(result.success).toBe(true)
  })

  it('accepts config with admin block (forward-compat for foundations)', () => {
    const result = SiteConfigSchema.safeParse({
      name: 'main',
      // Top-level cache field holds the constructed AdminCache instance
      // (Path X). Zod accepts it as opaque (z.unknown()).
      cache: { get: () => null, set: () => {}, invalidate: () => {} },
      admin: {
        auth: { trust: 'cloudflare-access' },
        plugins: [],
        audit: { providers: ['history'] },
      },
    })
    expect(result.success).toBe(true)
  })

  it('rejects config without name', () => {
    const result = SiteConfigSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('rejects config with empty name', () => {
    const result = SiteConfigSchema.safeParse({ name: '' })
    expect(result.success).toBe(false)
  })

  it('rejects malformed locale codes', () => {
    const result = SiteConfigSchema.safeParse({
      name: 'main',
      locales: { default: 'EN', supported: ['EN'] }, // uppercase rejected
    })
    expect(result.success).toBe(false)
  })

  it('accepts BCP 47 locale variants', () => {
    const valid = ['en', 'fr', 'pt-br', 'en-gb', 'zh-hans']
    for (const locale of valid) {
      const result = SiteConfigSchema.safeParse({
        name: 'main',
        locales: { default: locale, supported: [locale] },
      })
      expect(result.success, `${locale} should be valid`).toBe(true)
    }
  })

  it('rejects theme names with uppercase', () => {
    const result = SiteConfigSchema.safeParse({
      name: 'main',
      themes: { supported: ['Light'] }, // uppercase rejected
    })
    expect(result.success).toBe(false)
  })

  it('rejects unknown top-level fields (strict)', () => {
    const result = SiteConfigSchema.safeParse({
      name: 'main',
      unknownField: 'x',
    })
    expect(result.success).toBe(false)
  })

  it('requires locales.supported to be non-empty', () => {
    const result = SiteConfigSchema.safeParse({
      name: 'main',
      locales: { supported: [] },
    })
    expect(result.success).toBe(false)
  })
})

describe('GazettaConfigSchema validation', () => {
  it('accepts empty config', () => {
    const result = GazettaConfigSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('accepts full config', () => {
    const result = GazettaConfigSchema.safeParse({
      logLevel: 'debug',
      telemetry: false,
      dev: { port: 3000, hostname: 'localhost' },
      // Path X — factory result. Schema treats it as opaque (z.unknown).
      defaults: { cache: memoryCache({ maxEntries: 10000, maxBytes: 50_000_000 }) },
      mcp: { enabled: true, port: 3100 },
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid logLevel', () => {
    const result = GazettaConfigSchema.safeParse({ logLevel: 'verbose' })
    expect(result.success).toBe(false)
  })

  it('rejects out-of-range port', () => {
    const result = GazettaConfigSchema.safeParse({ dev: { port: 0 } })
    expect(result.success).toBe(false)
  })

  it('rejects unknown top-level fields (strict)', () => {
    const result = GazettaConfigSchema.safeParse({ unknownField: 'x' })
    expect(result.success).toBe(false)
  })
})

describe('Config error classes', () => {
  it('ConfigError is the base class', () => {
    const err = new ConfigError('boom')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('ConfigError')
  })

  it('ConfigValidationError carries file path', () => {
    const err = new ConfigValidationError('schema mismatch', '/path/to/site.config.ts')
    expect(err.filePath).toBe('/path/to/site.config.ts')
    expect(err.message).toContain('/path/to/site.config.ts')
    expect(err).toBeInstanceOf(ConfigError)
  })

  it('ConfigEvaluationError carries file path', () => {
    const err = new ConfigEvaluationError('syntax error', '/path/to/gazetta.config.ts')
    expect(err.filePath).toBe('/path/to/gazetta.config.ts')
    expect(err).toBeInstanceOf(ConfigError)
  })

  it('ConfigLayoutError signals flat + sites/ conflict', () => {
    const err = new ConfigLayoutError('conflict')
    expect(err).toBeInstanceOf(ConfigError)
    expect(err.name).toBe('ConfigLayoutError')
  })

  it('errors preserve cause', () => {
    const cause = new Error('underlying')
    const err = new ConfigEvaluationError('failed', '/path', { cause })
    expect(err.cause).toBe(cause)
  })
})
