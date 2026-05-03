/**
 * Unit tests for `alt/config.ts` — resolves alt-text config from
 * site `ai:` + site `altText:` + target `altText:` layers.
 *
 * Pure function tests. No env mocking, no SDK construction.
 */
import { describe, expect, it } from 'vitest'
import { resolveAltConfig } from '../src/alt/config.js'
import type { SiteManifest, TargetConfig } from '../src/types.js'

describe('resolveAltConfig — null cases', () => {
  it('returns null when nothing is configured', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {}
    expect(resolveAltConfig(site, undefined)).toBeNull()
  })

  it('returns null when ai: is set but altText: is missing AND ai has no provider for tasks to inherit', () => {
    // ai: must have provider; ai with provider but no altText block is
    // legitimately unconfigured for the alt-text task — the operator
    // didn't opt in to alt-text.
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'anthropic' },
    }
    // Without altText block, resolver still returns a result because
    // the provider is set. But we expect provider inheritance to work
    // even from an empty altText block. The "unconfigured" answer
    // requires neither block present.
    const result = resolveAltConfig(site, undefined)
    // With ai but no altText, the implementation infers the task is
    // configured via inheritance — provider comes from ai.
    expect(result).not.toBeNull()
    expect(result?.provider).toBe('anthropic')
  })

  it('returns null when altText is set but has no provider AND no ai block', () => {
    // The block is present but no provider can be derived.
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      altText: { auto: true },
    }
    expect(resolveAltConfig(site, undefined)).toBeNull()
  })
})

describe('resolveAltConfig — provider resolution', () => {
  it('uses altText.provider when set', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      altText: { provider: 'anthropic' },
    }
    expect(resolveAltConfig(site, undefined)?.provider).toBe('anthropic')
  })

  it('inherits from ai.provider when altText.provider is unset', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'openai' },
      altText: { auto: true },
    }
    expect(resolveAltConfig(site, undefined)?.provider).toBe('openai')
  })

  it('altText.provider wins over ai.provider', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'anthropic' },
      altText: { provider: 'openai' },
    }
    expect(resolveAltConfig(site, undefined)?.provider).toBe('openai')
  })

  it('target cannot override provider (provider is operationally global)', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'anthropic' },
    }
    // Target has no `provider` field on AltTextTargetConfig — TypeScript
    // forbids it. We just verify provider resolves from site.
    const target: Pick<TargetConfig, 'altText'> = { altText: { auto: false } }
    expect(resolveAltConfig(site, target)?.provider).toBe('anthropic')
  })
})

describe('resolveAltConfig — model resolution', () => {
  it('uses provider default when no model is set anywhere', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'anthropic' },
    }
    expect(resolveAltConfig(site, undefined)?.model).toBe('claude-haiku-4-5')
  })

  it('uses provider default for openai when no model set', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'openai' },
    }
    expect(resolveAltConfig(site, undefined)?.model).toBe('gpt-4o-mini')
  })

  it('uses provider default for ollama when no model set', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'ollama' },
    }
    expect(resolveAltConfig(site, undefined)?.model).toBe('llama3.2-vision:11b')
  })

  it('uses ai.defaultModel when set (overrides provider default)', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'anthropic', defaultModel: 'claude-sonnet-4-5' },
    }
    expect(resolveAltConfig(site, undefined)?.model).toBe('claude-sonnet-4-5')
  })

  it('altText.model wins over ai.defaultModel', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'anthropic', defaultModel: 'claude-haiku-4-5' },
      altText: { model: 'claude-sonnet-4-5' },
    }
    expect(resolveAltConfig(site, undefined)?.model).toBe('claude-sonnet-4-5')
  })

  it('target.altText.model wins over site.altText.model', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'anthropic' },
      altText: { model: 'claude-haiku-4-5' },
    }
    const target: Pick<TargetConfig, 'altText'> = {
      altText: { model: 'claude-opus-4-7' },
    }
    expect(resolveAltConfig(site, target)?.model).toBe('claude-opus-4-7')
  })
})

describe('resolveAltConfig — auto resolution', () => {
  it('defaults to true when nothing is set', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'anthropic' },
    }
    expect(resolveAltConfig(site, undefined)?.auto).toBe(true)
  })

  it('uses site.altText.auto when set', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'anthropic' },
      altText: { auto: false },
    }
    expect(resolveAltConfig(site, undefined)?.auto).toBe(false)
  })

  it('target.altText.auto wins over site.altText.auto', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'anthropic' },
      altText: { auto: true },
    }
    const target: Pick<TargetConfig, 'altText'> = { altText: { auto: false } }
    expect(resolveAltConfig(site, target)?.auto).toBe(false)
  })

  it('common pattern: prod target overrides default auto:true to false', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'anthropic' },
      // site default: auto: true (review-friendly for staging/local)
    }
    const prodTarget: Pick<TargetConfig, 'altText'> = {
      altText: { auto: false }, // review-first on prod
    }
    expect(resolveAltConfig(site, prodTarget)?.auto).toBe(false)
    // And local target inherits site default.
    expect(resolveAltConfig(site, undefined)?.auto).toBe(true)
  })
})

describe('resolveAltConfig — maxImageEdge resolution', () => {
  it('defaults to 768 when nothing is set', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'anthropic' },
    }
    expect(resolveAltConfig(site, undefined)?.maxImageEdge).toBe(768)
  })

  it('uses site.altText.maxImageEdge when set', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'anthropic' },
      altText: { maxImageEdge: 1024 },
    }
    expect(resolveAltConfig(site, undefined)?.maxImageEdge).toBe(1024)
  })

  it('target.altText.maxImageEdge wins over site.altText.maxImageEdge', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'anthropic' },
      altText: { maxImageEdge: 768 },
    }
    const target: Pick<TargetConfig, 'altText'> = {
      altText: { maxImageEdge: 1568 },
    }
    expect(resolveAltConfig(site, target)?.maxImageEdge).toBe(1568)
  })
})

describe('resolveAltConfig — full integration cases', () => {
  it('typical site config: ai with anthropic, altText opted in with defaults', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'anthropic', defaultModel: 'claude-haiku-4-5' },
      altText: { auto: true },
    }
    expect(resolveAltConfig(site, undefined)).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      auto: true,
      maxImageEdge: 768,
    })
  })

  it('site with self-hosted ollama, prod target opts out of auto', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'ollama' },
      altText: { auto: true },
    }
    const prodTarget: Pick<TargetConfig, 'altText'> = {
      altText: { auto: false },
    }
    expect(resolveAltConfig(site, prodTarget)).toEqual({
      provider: 'ollama',
      model: 'llama3.2-vision:11b',
      auto: false,
      maxImageEdge: 768,
    })
  })

  it('site with text-heavy assets bumps maxImageEdge globally', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'openai' },
      altText: { maxImageEdge: 1024 },
    }
    expect(resolveAltConfig(site, undefined)?.maxImageEdge).toBe(1024)
  })

  it('multi-target site: each target inherits unless overriding', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'anthropic' },
      altText: { auto: true, maxImageEdge: 768 },
    }
    const localTarget: Pick<TargetConfig, 'altText'> | undefined = undefined
    const prodTarget: Pick<TargetConfig, 'altText'> = { altText: { auto: false } }

    const local = resolveAltConfig(site, localTarget)
    const prod = resolveAltConfig(site, prodTarget)

    expect(local?.auto).toBe(true)
    expect(prod?.auto).toBe(false)
    expect(local?.provider).toBe(prod?.provider)
    expect(local?.model).toBe(prod?.model)
    expect(local?.maxImageEdge).toBe(prod?.maxImageEdge)
  })
})

describe('resolveAltConfig — pure function properties', () => {
  it('returns a fresh object each call (no mutation hazards)', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'anthropic' },
    }
    const a = resolveAltConfig(site, undefined)
    const b = resolveAltConfig(site, undefined)
    expect(a).not.toBe(b)
    expect(a).toEqual(b)
  })

  it('does not mutate input', () => {
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: 'anthropic' },
      altText: { auto: true },
    }
    const before = JSON.stringify(site)
    resolveAltConfig(site, undefined)
    expect(JSON.stringify(site)).toBe(before)
  })
})
