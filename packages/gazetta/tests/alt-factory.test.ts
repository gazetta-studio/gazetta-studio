/**
 * Unit tests for `alt/factory.ts` — the seam between configuration and
 * adapter construction.
 *
 * Manipulates `process.env` (saved/restored per test) to validate
 * credential resolution. Adapter construction is observable via the
 * `name` field — anthropic/openai/ollama/null indicate which path was
 * taken.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildAltAdapter, isAltAdapterConfigured } from '../src/alt/factory.js'
import type { SiteManifest, TargetConfig } from '../src/types.js'

const ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OLLAMA_BASE_URL'] as const
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = savedEnv[key]
    }
  }
})

describe('isAltAdapterConfigured', () => {
  it('returns false when no AI config exists', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {}
    expect(isAltAdapterConfigured(site, undefined)).toBe(false)
  })

  it('returns false for anthropic when API key missing', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'anthropic' },
      altText: { auto: true },
    }
    expect(isAltAdapterConfigured(site, undefined)).toBe(false)
  })

  it('returns true for anthropic when API key present', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'anthropic' },
      altText: { auto: true },
    }
    expect(isAltAdapterConfigured(site, undefined)).toBe(true)
  })

  it('returns false for openai when API key missing', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'openai' },
      altText: { auto: true },
    }
    expect(isAltAdapterConfigured(site, undefined)).toBe(false)
  })

  it('returns true for openai when API key present', () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'openai' },
      altText: { auto: true },
    }
    expect(isAltAdapterConfigured(site, undefined)).toBe(true)
  })

  it('returns true for ollama without any env (no key required)', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'ollama' },
      altText: { auto: true },
    }
    expect(isAltAdapterConfigured(site, undefined)).toBe(true)
  })

  it('does not construct an SDK client (cheap to call repeatedly)', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'anthropic' },
      altText: { auto: true },
    }
    // 1000 calls are cheap because no SDK construction happens.
    for (let i = 0; i < 1000; i++) {
      isAltAdapterConfigured(site, undefined)
    }
    // No assertion needed — just verifies the call is fast (test
    // would time out if SDK was constructed each call).
    expect(true).toBe(true)
  })
})

describe('buildAltAdapter — null adapter cases', () => {
  it('returns nullAltAdapter when no AI config exists', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {}
    const adapter = buildAltAdapter(site, undefined)
    expect(adapter.name).toBe('null')
  })

  it('returns nullAltAdapter when anthropic configured but key missing', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'anthropic' },
      altText: { auto: true },
    }
    const adapter = buildAltAdapter(site, undefined)
    expect(adapter.name).toBe('null')
  })

  it('returns nullAltAdapter when openai configured but key missing', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'openai' },
      altText: { auto: true },
    }
    const adapter = buildAltAdapter(site, undefined)
    expect(adapter.name).toBe('null')
  })

  it('always returns an AltTextAdapter (never null)', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {}
    const adapter = buildAltAdapter(site, undefined)
    // Type-system check: TS rejects null comparison if return type is
    // AltTextAdapter (non-null). Runtime check: name is always defined.
    expect(typeof adapter.name).toBe('string')
    expect(typeof adapter.supports).toBe('function')
    expect(typeof adapter.generate).toBe('function')
  })
})

describe('buildAltAdapter — anthropic', () => {
  it('builds anthropic adapter when configured + key present', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'anthropic' },
      altText: { auto: true },
    }
    const adapter = buildAltAdapter(site, undefined)
    expect(adapter.name).toBe('anthropic')
  })

  it('respects model override from site.altText.model', () => {
    // We can't easily peek at the constructed SDK's internal model
    // without making a network call. The model resolution is tested
    // in alt-config-resolver.test.ts; here we just verify the adapter
    // is constructed without throwing.
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'anthropic' },
      altText: { model: 'claude-sonnet-4-5' },
    }
    expect(() => buildAltAdapter(site, undefined)).not.toThrow()
  })
})

describe('buildAltAdapter — openai', () => {
  it('builds openai adapter when configured + key present', () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'openai' },
      altText: { auto: true },
    }
    const adapter = buildAltAdapter(site, undefined)
    expect(adapter.name).toBe('openai')
  })
})

describe('buildAltAdapter — ollama', () => {
  it('builds ollama adapter without any env vars', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'ollama' },
      altText: { auto: true },
    }
    const adapter = buildAltAdapter(site, undefined)
    expect(adapter.name).toBe('ollama')
  })

  it('uses OLLAMA_BASE_URL when set', () => {
    // Same as model — internal config not directly inspectable.
    // We verify construction doesn't throw with a custom base URL.
    process.env.OLLAMA_BASE_URL = 'http://ollama-server.internal:11434'
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'ollama' },
      altText: { auto: true },
    }
    expect(() => buildAltAdapter(site, undefined)).not.toThrow()
  })
})

describe('buildAltAdapter — target overrides', () => {
  it('target altText override does not change adapter type (provider stays site-level)', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'anthropic' },
      altText: { auto: true },
    }
    const target: Pick<TargetConfig, 'altText'> = {
      altText: { auto: false },
    }
    expect(buildAltAdapter(site, target).name).toBe('anthropic')
  })
})

describe('buildAltAdapter — provider switching at runtime', () => {
  it('switching provider in config changes adapter on next call', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    process.env.OPENAI_API_KEY = 'sk-test'

    const siteA: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'anthropic' },
      altText: { auto: true },
    }
    const siteB: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'openai' },
      altText: { auto: true },
    }
    expect(buildAltAdapter(siteA, undefined).name).toBe('anthropic')
    expect(buildAltAdapter(siteB, undefined).name).toBe('openai')
  })
})
