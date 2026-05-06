/**
 * Unit tests for `ensureComponentIds` — the stable-ID injector for
 * InlineComponent entries within page/fragment manifests. The
 * collaboration design (`design-collaboration.md`) requires that:
 *
 *   - Every InlineComponent has an `id` after save
 *   - Existing IDs are preserved across saves (component reorders
 *     and edits don't churn IDs)
 *   - Fragment-reference strings (`"@header"`) don't carry IDs —
 *     they point at a separate manifest with its own components
 *   - Nested components (composite InlineComponent → child
 *     InlineComponents) recurse correctly
 */
import { describe, expect, it } from 'vitest'
import type { ComponentEntry } from '../src/types.js'
import { ensureComponentIds } from '../src/component-ids.js'

/** Deterministic counter generator for test predictability. */
function counterGenerator(prefix = 'id'): () => string {
  let i = 0
  return () => `${prefix}-${++i}`
}

describe('ensureComponentIds', () => {
  it('returns empty array when components is undefined', () => {
    expect(ensureComponentIds(undefined)).toEqual([])
  })

  it('returns empty array when components is empty', () => {
    expect(ensureComponentIds([])).toEqual([])
  })

  it('passes fragment-reference strings through unchanged', () => {
    const components: ComponentEntry[] = ['@header', '@footer']
    const result = ensureComponentIds(components, counterGenerator())
    expect(result).toEqual(['@header', '@footer'])
  })

  it('injects IDs on InlineComponents that lack one', () => {
    const components: ComponentEntry[] = [
      { name: 'hero', template: 'hero' },
      { name: 'features', template: 'feature-grid' },
    ]
    const result = ensureComponentIds(components, counterGenerator())
    expect(result).toEqual([
      { id: 'id-1', name: 'hero', template: 'hero' },
      { id: 'id-2', name: 'features', template: 'feature-grid' },
    ])
  })

  it('preserves existing IDs across saves', () => {
    const components: ComponentEntry[] = [
      { id: 'pre-existing-1', name: 'hero', template: 'hero' },
      { id: 'pre-existing-2', name: 'features', template: 'feature-grid' },
    ]
    const result = ensureComponentIds(components, counterGenerator())
    expect(result).toEqual(components)
    // Identity-equality preserved when nothing changes (cheap re-saves).
    expect(result[0]).toBe(components[0])
    expect(result[1]).toBe(components[1])
  })

  it('mixes preserved and injected IDs in one pass', () => {
    const components: ComponentEntry[] = [
      { id: 'pre-existing', name: 'hero', template: 'hero' },
      { name: 'features', template: 'feature-grid' },
      '@footer',
    ]
    const result = ensureComponentIds(components, counterGenerator())
    expect(result).toEqual([
      { id: 'pre-existing', name: 'hero', template: 'hero' },
      { id: 'id-1', name: 'features', template: 'feature-grid' },
      '@footer',
    ])
  })

  it('recurses into nested components', () => {
    const components: ComponentEntry[] = [
      {
        name: 'layout',
        template: 'two-column',
        components: [
          { name: 'left', template: 'card' },
          { id: 'right-existing', name: 'right', template: 'card' },
          '@sidebar',
        ],
      },
    ]
    const result = ensureComponentIds(components, counterGenerator())
    // The outer component gets an ID; its nested children also get
    // IDs in deterministic order. The fragment ref stays unchanged.
    // Outer is processed FIRST in the recursion (depth-first per
    // ensureInline's recurse-then-id construction), so the outer
    // component's children consume IDs before the outer itself.
    expect(result).toHaveLength(1)
    const outer = result[0] as Extract<ComponentEntry, { name: string }>
    expect(outer.id).toBeDefined()
    expect(outer.components).toHaveLength(3)
    const children = outer.components!
    expect((children[0] as Extract<ComponentEntry, { name: string }>).id).toBe('id-1')
    expect((children[1] as Extract<ComponentEntry, { name: string }>).id).toBe('right-existing')
    expect(children[2]).toBe('@sidebar')
    // Outer's id is whatever counter value followed the children
    expect(outer.id).toBe('id-2')
  })

  it('does not mutate the input array', () => {
    const components: ComponentEntry[] = [{ name: 'hero', template: 'hero' }]
    const before = JSON.stringify(components)
    ensureComponentIds(components, counterGenerator())
    expect(JSON.stringify(components)).toBe(before)
  })

  it('uses real NanoID by default (no generator provided)', () => {
    const components: ComponentEntry[] = [{ name: 'hero', template: 'hero' }]
    const result = ensureComponentIds(components)
    const first = result[0] as Extract<ComponentEntry, { name: string }>
    // Default NanoID is 21 chars, URL-safe. Don't assert exact length
    // because nanoid is a peer dep; just sanity-check shape.
    expect(typeof first.id).toBe('string')
    expect(first.id!.length).toBeGreaterThan(10)
  })

  it('two consecutive runs without IDs produce different IDs (real NanoID)', () => {
    // Sanity check that the default generator produces distinct IDs
    // — if not, we'd have a global-counter bug.
    const a = ensureComponentIds([{ name: 'x', template: 'x' }])
    const b = ensureComponentIds([{ name: 'x', template: 'x' }])
    const aId = (a[0] as Extract<ComponentEntry, { name: string }>).id
    const bId = (b[0] as Extract<ComponentEntry, { name: string }>).id
    expect(aId).not.toBe(bId)
  })

  it('preserves content + template fields when adding ID', () => {
    const components: ComponentEntry[] = [
      { name: 'hero', template: 'hero', content: { title: 'Welcome', subtitle: 'Hello' } },
    ]
    const result = ensureComponentIds(components, counterGenerator())
    const out = result[0] as Extract<ComponentEntry, { name: string }>
    expect(out.id).toBe('id-1')
    expect(out.name).toBe('hero')
    expect(out.template).toBe('hero')
    expect(out.content).toEqual({ title: 'Welcome', subtitle: 'Hello' })
  })

  it('reorder + re-save preserves IDs (the load-bearing collaboration invariant)', () => {
    // Simulate the most important real-world case: author reorders
    // components, then saves. IDs must NOT regenerate, or every
    // reorder would orphan all inline comments anchored to the
    // reordered components.
    const original: ComponentEntry[] = [
      { id: 'hero-001', name: 'hero', template: 'hero' },
      { id: 'features-001', name: 'features', template: 'feature-grid' },
      { id: 'cta-001', name: 'cta', template: 'cta' },
    ]
    // Author reorders: features moves to position 0
    const reordered: ComponentEntry[] = [original[1], original[0], original[2]]
    const result = ensureComponentIds(reordered, counterGenerator())
    expect(result.map(c => (c as Extract<ComponentEntry, { name: string }>).id)).toEqual([
      'features-001',
      'hero-001',
      'cta-001',
    ])
  })
})
