/**
 * Unit tests for `alt/prompt-policies.ts` — five alt-text-specific
 * policies + the default policy set + composition behavior with the
 * generic `composePrompt`.
 */
import { describe, expect, it } from 'vitest'
import { composePrompt } from '../src/ai/compose-prompt.js'
import { DEFAULT_ALT_REQUEST, type AltRequest } from '../src/alt/adapter.js'
import {
  DEFAULT_ALT_PROMPT_POLICIES,
  lengthPolicy,
  localePolicy,
  outputDisciplinePolicy,
  styleGuidancePolicy,
  taskFramingPolicy,
} from '../src/alt/prompt-policies.js'

const REQ_DEFAULT: AltRequest = { ...DEFAULT_ALT_REQUEST }
const REQ_FRENCH: AltRequest = { ...DEFAULT_ALT_REQUEST, locale: 'fr' }
const REQ_LONG: AltRequest = { ...DEFAULT_ALT_REQUEST, maxChars: 500 }

describe('taskFramingPolicy', () => {
  it('mentions WCAG and alt-text framing', () => {
    const result = taskFramingPolicy(REQ_DEFAULT)
    expect(result).toContain('WCAG')
    expect(result.toLowerCase()).toContain('alt text')
  })

  it('returns the same string regardless of request fields', () => {
    expect(taskFramingPolicy(REQ_DEFAULT)).toBe(taskFramingPolicy(REQ_FRENCH))
    expect(taskFramingPolicy(REQ_DEFAULT)).toBe(taskFramingPolicy(REQ_LONG))
  })
})

describe('styleGuidancePolicy', () => {
  it('produces descriptive guidance for style: descriptive', () => {
    const result = styleGuidancePolicy(REQ_DEFAULT)
    expect(result).toContain('Describe')
    // Mentions the anti-pattern guidance.
    expect(result.toLowerCase()).toContain('image of')
    expect(result.toLowerCase()).toContain('picture of')
  })
})

describe('lengthPolicy', () => {
  it('embeds the maxChars value', () => {
    expect(lengthPolicy(REQ_DEFAULT)).toContain('125')
    expect(lengthPolicy(REQ_LONG)).toContain('500')
  })

  it('uses "Maximum N characters" wording', () => {
    expect(lengthPolicy(REQ_DEFAULT)).toMatch(/Maximum \d+ characters/)
  })
})

describe('localePolicy', () => {
  it('returns empty string for default locale (en)', () => {
    expect(localePolicy(REQ_DEFAULT)).toBe('')
  })

  it('asks for target language when locale ≠ en', () => {
    const result = localePolicy(REQ_FRENCH)
    expect(result).not.toBe('')
    expect(result.toLowerCase()).toContain('write the description')
    expect(result).toContain('fr')
  })

  it('handles BCP 47 locale codes verbatim', () => {
    const reqPtBR: AltRequest = { ...DEFAULT_ALT_REQUEST, locale: 'pt-BR' }
    expect(localePolicy(reqPtBR)).toContain('pt-BR')
  })

  it('handles non-Latin locale codes', () => {
    const reqAr: AltRequest = { ...DEFAULT_ALT_REQUEST, locale: 'ar' }
    expect(localePolicy(reqAr)).toContain('ar')
  })
})

describe('outputDisciplinePolicy', () => {
  it('asks for description-only output', () => {
    const result = outputDisciplinePolicy(REQ_DEFAULT)
    expect(result.toLowerCase()).toContain('output')
    // Suggests no preamble.
    expect(result.toLowerCase()).toContain('preamble')
  })
})

describe('DEFAULT_ALT_PROMPT_POLICIES', () => {
  it('has five policies in the documented order', () => {
    expect(DEFAULT_ALT_PROMPT_POLICIES).toHaveLength(5)
    expect(DEFAULT_ALT_PROMPT_POLICIES[0]).toBe(taskFramingPolicy)
    expect(DEFAULT_ALT_PROMPT_POLICIES[1]).toBe(styleGuidancePolicy)
    expect(DEFAULT_ALT_PROMPT_POLICIES[2]).toBe(lengthPolicy)
    expect(DEFAULT_ALT_PROMPT_POLICIES[3]).toBe(localePolicy)
    expect(DEFAULT_ALT_PROMPT_POLICIES[4]).toBe(outputDisciplinePolicy)
  })

  it('composes into a coherent prompt for default request', () => {
    const result = composePrompt(REQ_DEFAULT, DEFAULT_ALT_PROMPT_POLICIES)
    // Multi-paragraph (locale policy drops out for 'en'); other 4 stay.
    expect(result.split('\n\n').length).toBe(4)
    expect(result).toContain('WCAG')
    expect(result).toContain('125 characters')
  })

  it('includes locale paragraph when locale ≠ en', () => {
    const result = composePrompt(REQ_FRENCH, DEFAULT_ALT_PROMPT_POLICIES)
    expect(result.split('\n\n').length).toBe(5)
    expect(result).toContain('Write the description in fr')
  })

  it('reflects custom maxChars in the composed prompt', () => {
    const result = composePrompt(REQ_LONG, DEFAULT_ALT_PROMPT_POLICIES)
    expect(result).toContain('500 characters')
    expect(result).not.toContain('125 characters')
  })
})
