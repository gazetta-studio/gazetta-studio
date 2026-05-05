/**
 * Tests for `resolveAltConfig` — the three-rung inheritance chain
 * (target → site → gazetta) that produces a `ResolvedAltConfig`.
 *
 * Per Phase 4 of the Path X migration: `provider` is a constructed
 * `AIProvider` instance (not a string discriminator); `model`,
 * `systemPrompt`, `maxTokens` are data literals inheriting per-field
 * across rungs.
 */
import { describe, expect, it } from 'vitest'
import { anthropicProvider } from '../src/alt/anthropic.js'
import { openaiProvider } from '../src/alt/openai.js'
import { resolveAltConfig } from '../src/alt/config.js'
import type { AIProvider } from '../src/ai/provider.js'
import { MAX_EDGE } from '../src/ai/vision-prep.js'
import type { GazettaManifest, SiteManifest, TargetConfig } from '../src/types.js'

// Constructed provider instances reused across tests. Per-task config
// (model, systemPrompt, maxTokens) flows through the resolver chain;
// the provider transport stays constant.
const anthropic: AIProvider = anthropicProvider({ apiKey: 'sk-ant-test' })
const openai: AIProvider = openaiProvider({ apiKey: 'sk-oai-test' })

describe('resolveAltConfig — null cases', () => {
  it('returns null when no provider configured anywhere', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {}
    expect(resolveAltConfig(site, undefined)).toBeNull()
  })

  it('returns null when ai: is set but provider is absent', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { model: 'claude-haiku-4-5' },
    }
    expect(resolveAltConfig(site, undefined)).toBeNull()
  })

  it('returns null when only behavior fields present (no provider)', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      altText: { systemPrompt: 'voice', maxTokens: 300 },
    }
    expect(resolveAltConfig(site, undefined)).toBeNull()
  })
})

describe('resolveAltConfig — provider resolution (three-rung chain)', () => {
  it('uses site.ai.provider when set', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: anthropic },
    }
    expect(resolveAltConfig(site, undefined)?.provider).toBe(anthropic)
  })

  it('inherits from gazetta.ai.provider when site has none', () => {
    const gazetta: Pick<GazettaManifest, 'ai' | 'altText'> = {
      ai: { provider: anthropic },
    }
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {}
    expect(resolveAltConfig(site, undefined, gazetta)?.provider).toBe(anthropic)
  })

  it('site.ai.provider wins over gazetta.ai.provider', () => {
    const gazetta: Pick<GazettaManifest, 'ai' | 'altText'> = {
      ai: { provider: anthropic },
    }
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: openai },
    }
    expect(resolveAltConfig(site, undefined, gazetta)?.provider).toBe(openai)
  })

  it('target.altText.ai.provider wins over site and gazetta', () => {
    const gazetta: Pick<GazettaManifest, 'ai' | 'altText'> = {
      ai: { provider: anthropic },
    }
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: anthropic },
    }
    const target: Pick<TargetConfig, 'altText'> = {
      altText: { ai: { provider: openai } },
    }
    expect(resolveAltConfig(site, target, gazetta)?.provider).toBe(openai)
  })
})

describe('resolveAltConfig — model resolution', () => {
  it('falls back to PROVIDER_DEFAULT_MODELS when no model anywhere in chain', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: anthropic },
    }
    expect(resolveAltConfig(site, undefined)?.model).toBe('claude-haiku-4-5')
  })

  it('uses site.ai.model when set', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: anthropic, model: 'claude-sonnet-4-5' },
    }
    expect(resolveAltConfig(site, undefined)?.model).toBe('claude-sonnet-4-5')
  })

  it('inherits from gazetta.ai.model when site has none', () => {
    const gazetta: Pick<GazettaManifest, 'ai' | 'altText'> = {
      ai: { provider: anthropic, model: 'claude-opus-4-7' },
    }
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: anthropic },
    }
    expect(resolveAltConfig(site, undefined, gazetta)?.model).toBe('claude-opus-4-7')
  })

  it('target.altText.ai.model wins over site, gazetta, and provider default', () => {
    const gazetta: Pick<GazettaManifest, 'ai' | 'altText'> = {
      ai: { provider: anthropic, model: 'claude-haiku-4-5' },
    }
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: anthropic, model: 'claude-sonnet-4-5' },
    }
    const target: Pick<TargetConfig, 'altText'> = {
      altText: { ai: { model: 'claude-opus-4-7' } },
    }
    expect(resolveAltConfig(site, target, gazetta)?.model).toBe('claude-opus-4-7')
  })

  it('uses different per-provider defaults when provider differs', () => {
    const siteAnthropic: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: anthropic },
    }
    const siteOpenai: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: openai },
    }
    expect(resolveAltConfig(siteAnthropic, undefined)?.model).toBe('claude-haiku-4-5')
    expect(resolveAltConfig(siteOpenai, undefined)?.model).toBe('gpt-4o-mini')
  })
})

describe('resolveAltConfig — systemPrompt resolution', () => {
  it('null when no systemPrompt anywhere in chain', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: anthropic },
    }
    expect(resolveAltConfig(site, undefined)?.systemPrompt).toBeNull()
  })

  it('uses site.altText.systemPrompt when set', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: anthropic },
      altText: { systemPrompt: 'site voice' },
    }
    expect(resolveAltConfig(site, undefined)?.systemPrompt).toBe('site voice')
  })

  it('inherits from gazetta.altText.systemPrompt when site has none', () => {
    const gazetta: Pick<GazettaManifest, 'ai' | 'altText'> = {
      altText: { systemPrompt: 'agency voice' },
    }
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: anthropic },
    }
    expect(resolveAltConfig(site, undefined, gazetta)?.systemPrompt).toBe('agency voice')
  })

  it('target.altText.ai.systemPrompt wins over site and gazetta', () => {
    const gazetta: Pick<GazettaManifest, 'ai' | 'altText'> = {
      altText: { systemPrompt: 'agency voice' },
    }
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: anthropic },
      altText: { systemPrompt: 'site voice' },
    }
    const target: Pick<TargetConfig, 'altText'> = {
      altText: { ai: { systemPrompt: 'prod voice' } },
    }
    expect(resolveAltConfig(site, target, gazetta)?.systemPrompt).toBe('prod voice')
  })
})

describe('resolveAltConfig — maxTokens resolution', () => {
  it('undefined when no maxTokens anywhere', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: anthropic },
    }
    expect(resolveAltConfig(site, undefined)?.maxTokens).toBeUndefined()
  })

  it('inherits per-rung', () => {
    const gazetta: Pick<GazettaManifest, 'ai' | 'altText'> = {
      altText: { maxTokens: 200 },
    }
    const site1: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: anthropic },
    }
    expect(resolveAltConfig(site1, undefined, gazetta)?.maxTokens).toBe(200)

    const site2: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: anthropic },
      altText: { maxTokens: 300 },
    }
    expect(resolveAltConfig(site2, undefined, gazetta)?.maxTokens).toBe(300)

    const target: Pick<TargetConfig, 'altText'> = {
      altText: { ai: { maxTokens: 400 } },
    }
    expect(resolveAltConfig(site2, target, gazetta)?.maxTokens).toBe(400)
  })
})

describe('resolveAltConfig — behavior fields (auto, maxImageEdge)', () => {
  it('defaults auto to true', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: anthropic },
    }
    expect(resolveAltConfig(site, undefined)?.auto).toBe(true)
  })

  it('site.altText.auto wins when set', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: anthropic },
      altText: { auto: false },
    }
    expect(resolveAltConfig(site, undefined)?.auto).toBe(false)
  })

  it('target.altText.auto wins over site', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: anthropic },
      altText: { auto: true },
    }
    const target: Pick<TargetConfig, 'altText'> = { altText: { auto: false } }
    expect(resolveAltConfig(site, target)?.auto).toBe(false)
  })

  it('defaults maxImageEdge to MAX_EDGE', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: anthropic },
    }
    expect(resolveAltConfig(site, undefined)?.maxImageEdge).toBe(MAX_EDGE)
  })

  it('target.altText.maxImageEdge wins over site', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: anthropic },
      altText: { maxImageEdge: 1024 },
    }
    const target: Pick<TargetConfig, 'altText'> = { altText: { maxImageEdge: 2048 } }
    expect(resolveAltConfig(site, target)?.maxImageEdge).toBe(2048)
  })
})

describe('resolveAltConfig — full chain scenario', () => {
  it('full three-rung scenario: gazetta provider + site model + target prompt', () => {
    const gazetta: Pick<GazettaManifest, 'ai' | 'altText'> = {
      ai: { provider: anthropic, model: 'claude-haiku-4-5' },
      altText: { systemPrompt: 'agency voice', maxTokens: 200 },
    }
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { model: 'claude-sonnet-4-5' }, // overrides model only
      altText: { auto: false }, // overrides behavior
    }
    const target: Pick<TargetConfig, 'altText'> = {
      altText: {
        ai: { systemPrompt: 'prod-specific voice' }, // overrides systemPrompt
        maxImageEdge: 1024, // overrides behavior
      },
    }

    const resolved = resolveAltConfig(site, target, gazetta)
    expect(resolved).not.toBeNull()
    expect(resolved?.provider).toBe(anthropic) // inherited from gazetta
    expect(resolved?.model).toBe('claude-sonnet-4-5') // overridden at site
    expect(resolved?.systemPrompt).toBe('prod-specific voice') // overridden at target
    expect(resolved?.maxTokens).toBe(200) // inherited from gazetta
    expect(resolved?.auto).toBe(false) // overridden at site
    expect(resolved?.maxImageEdge).toBe(1024) // overridden at target
  })
})
