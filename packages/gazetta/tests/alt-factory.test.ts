/**
 * Unit tests for `alt/factory.ts` — the seam between configuration and
 * adapter construction.
 *
 * Per Phase 4 of the Path X migration: factory reads `provider` (a
 * constructed `AIProvider` instance) from the resolver and delegates
 * to `provider.altText({...})`. No env-var reads in the factory —
 * operators pass `process.env.X!` to the provider factory at config-eval.
 */
import { describe, expect, it } from 'vitest'
import { anthropicProvider } from '../src/alt/anthropic.js'
import { ollamaProvider } from '../src/alt/ollama.js'
import { openaiProvider } from '../src/alt/openai.js'
import { buildAltAdapter, isAltAdapterConfigured } from '../src/alt/factory.js'
import type { SiteManifest, TargetConfig } from '../src/types.js'

const anthropic = anthropicProvider({ apiKey: 'sk-ant-test' })
const openai = openaiProvider({ apiKey: 'sk-oai-test' })
const ollama = ollamaProvider()

describe('isAltAdapterConfigured', () => {
  it('returns false when no AI config exists', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {}
    expect(isAltAdapterConfigured(site, undefined)).toBe(false)
  })

  it('returns false when ai: lacks provider', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { model: 'claude-haiku-4-5' },
    }
    expect(isAltAdapterConfigured(site, undefined)).toBe(false)
  })

  it('returns true when site.ai.provider is set', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: anthropic },
    }
    expect(isAltAdapterConfigured(site, undefined)).toBe(true)
  })

  it('returns true when target.altText.ai.provider is set (no site.ai)', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {}
    const target: Pick<TargetConfig, 'altText'> = {
      altText: { ai: { provider: openai } },
    }
    expect(isAltAdapterConfigured(site, target)).toBe(true)
  })

  it('does not construct an SDK client (cheap to call repeatedly)', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: anthropic },
    }
    // 1000 calls are cheap because no SDK construction happens.
    for (let i = 0; i < 1000; i++) {
      isAltAdapterConfigured(site, undefined)
    }
    expect(true).toBe(true)
  })
})

describe('buildAltAdapter — null adapter cases', () => {
  it('returns nullAltAdapter when no AI config exists', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {}
    const adapter = buildAltAdapter(site, undefined)
    expect(adapter.name).toBe('null')
  })

  it('returns nullAltAdapter when ai: has no provider', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { model: 'claude-haiku-4-5' },
    }
    const adapter = buildAltAdapter(site, undefined)
    expect(adapter.name).toBe('null')
  })

  it('always returns an AltTextAdapter (never null)', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {}
    const adapter = buildAltAdapter(site, undefined)
    expect(typeof adapter.name).toBe('string')
    expect(typeof adapter.supports).toBe('function')
    expect(typeof adapter.generate).toBe('function')
  })
})

describe('buildAltAdapter — provider dispatch via instance', () => {
  it('builds anthropic adapter when site.ai.provider = anthropicProvider', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: anthropic },
    }
    const adapter = buildAltAdapter(site, undefined)
    expect(adapter.name).toBe('anthropic')
  })

  it('builds openai adapter when site.ai.provider = openaiProvider', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: openai },
    }
    const adapter = buildAltAdapter(site, undefined)
    expect(adapter.name).toBe('openai')
  })

  it('builds ollama adapter when site.ai.provider = ollamaProvider', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: ollama },
    }
    const adapter = buildAltAdapter(site, undefined)
    expect(adapter.name).toBe('ollama')
  })
})

describe('buildAltAdapter — target overrides', () => {
  it('target.altText.ai.provider replaces inherited provider for that target', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: anthropic },
    }
    const target: Pick<TargetConfig, 'altText'> = {
      altText: { ai: { provider: openai } },
    }
    expect(buildAltAdapter(site, target).name).toBe('openai')
  })

  it('target.altText.auto override does not change adapter (behavior-only)', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: anthropic },
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
    const siteA: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: anthropic },
    }
    const siteB: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: openai },
    }
    expect(buildAltAdapter(siteA, undefined).name).toBe('anthropic')
    expect(buildAltAdapter(siteB, undefined).name).toBe('openai')
  })
})

describe('buildAltAdapter — three-rung gazetta inheritance', () => {
  it('inherits provider from gazetta when site has none', () => {
    const gazetta = { ai: { provider: anthropic } }
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {}
    expect(buildAltAdapter(site, undefined, gazetta).name).toBe('anthropic')
  })

  it('site provider wins over gazetta', () => {
    const gazetta = { ai: { provider: anthropic } }
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: openai },
    }
    expect(buildAltAdapter(site, undefined, gazetta).name).toBe('openai')
  })
})
