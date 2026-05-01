/**
 * Tests for `assets/manifest-merge.ts`.
 *
 * Covers:
 *   - applyLocaleOverrides: shallow spread of non-undefined fields,
 *     null preserves explicitly, undefined doesn't shadow base
 *   - foldLocaleChain: most-specific-LAST semantics; nulls in chain
 *     are no-ops
 */
import { describe, expect, it } from 'vitest'
import { applyLocaleOverrides, foldLocaleChain } from '../src/assets/manifest-merge.js'

describe('applyLocaleOverrides', () => {
  it('returns base when override is null', () => {
    const base = { a: 1, b: 2 }
    expect(applyLocaleOverrides(base, null)).toEqual({ a: 1, b: 2 })
  })

  it('does NOT mutate base', () => {
    const base = { a: 1, b: 2 }
    applyLocaleOverrides(base, { a: 99 })
    expect(base).toEqual({ a: 1, b: 2 })
  })

  it('spreads non-undefined fields onto base', () => {
    const base = { a: 1, b: 2, c: 3 }
    expect(applyLocaleOverrides(base, { a: 10, c: 30 })).toEqual({ a: 10, b: 2, c: 30 })
  })

  it('treats null as a value (not absent)', () => {
    // Locale's `alt: null` explicitly clears the default's alt.
    const base = { alt: 'default alt', focal: { x: 0.5, y: 0.5 } }
    expect(applyLocaleOverrides(base, { alt: null })).toEqual({
      alt: null,
      focal: { x: 0.5, y: 0.5 },
    })
  })

  it('does NOT shadow base with undefined override fields', () => {
    const base = { a: 1, b: 2 }
    // Override has b explicitly undefined — base's b should win.
    expect(applyLocaleOverrides(base, { a: 99, b: undefined })).toEqual({ a: 99, b: 2 })
  })

  it('handles overrides that introduce new keys (per-kind metadata)', () => {
    const base: Record<string, unknown> = { a: 1 }
    expect(applyLocaleOverrides(base, { newKey: 'hello' })).toEqual({ a: 1, newKey: 'hello' })
  })

  it('replaces atomic values wholesale (focalPoint, variants)', () => {
    const base = { focalPoint: { x: 0.5, y: 0.5 } }
    expect(applyLocaleOverrides(base, { focalPoint: { x: 0.2, y: 0.8 } })).toEqual({
      focalPoint: { x: 0.2, y: 0.8 },
    })
  })
})

describe('foldLocaleChain', () => {
  it('returns base when chain is empty', () => {
    const base = { a: 1, b: 2 }
    expect(foldLocaleChain(base, [])).toEqual({ a: 1, b: 2 })
  })

  it('applies overrides most-specific-LAST', () => {
    // Active pt-BR with fallback pt: chain order is [pt, pt-BR].
    // Step 1: apply pt onto default → {alt: 'pt alt', size: 100}
    // Step 2: apply pt-BR onto step 1 → {alt: 'pt-BR alt', size: 100}
    // pt-BR's alt wins because it's last.
    const base = { alt: 'default alt', size: 100 }
    const chain = [{ alt: 'pt alt' }, { alt: 'pt-BR alt' }]
    expect(foldLocaleChain(base, chain)).toEqual({ alt: 'pt-BR alt', size: 100 })
  })

  it('skips null entries in the chain', () => {
    // Locale variant didn't exist at one rung — no-op for that step.
    const base = { a: 1 }
    expect(foldLocaleChain(base, [null, { a: 99 }, null])).toEqual({ a: 99 })
  })

  it('cumulative overrides across chain', () => {
    // pt sets `b`; pt-BR sets `c`. Final has both AND default's `a`.
    const base = { a: 1, b: 2, c: 3 }
    const chain = [{ b: 20 }, { c: 30 }]
    expect(foldLocaleChain(base, chain)).toEqual({ a: 1, b: 20, c: 30 })
  })

  it('most-specific can override less-specific override', () => {
    // pt sets size=200; pt-BR overrides size=300.
    const base = { size: 100 }
    expect(foldLocaleChain(base, [{ size: 200 }, { size: 300 }])).toEqual({ size: 300 })
  })

  it('does NOT mutate base', () => {
    const base = { a: 1 }
    foldLocaleChain(base, [{ a: 99 }])
    expect(base).toEqual({ a: 1 })
  })
})
