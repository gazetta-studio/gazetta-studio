/**
 * Pure-function tests for the altRequired schema walker.
 *
 * The walker takes a JSON Schema (post-z.toJSONSchema) and returns the
 * field paths where the embeddedAsset metadata flagged altRequired: true.
 */
import { describe, it, expect } from 'vitest'
import { findAltRequiredPaths, readAtPath } from '../src/validation/alt-required-walker.js'

describe('findAltRequiredPaths', () => {
  it('returns empty for schemas without embeddedAsset metadata', () => {
    const schema = { type: 'object', properties: { title: { type: 'string' } } }
    expect(findAltRequiredPaths(schema)).toEqual([])
  })

  it('finds a top-level embeddedAsset field with altRequired', () => {
    const schema = {
      type: 'object',
      properties: {
        hero: {
          type: 'object',
          assetOptions: { altRequired: true, accept: ['image'] },
          properties: { _asset: { type: 'string' } },
        },
      },
    }
    expect(findAltRequiredPaths(schema)).toEqual(['hero'])
  })

  it('skips embeddedAsset fields without altRequired', () => {
    const schema = {
      type: 'object',
      properties: {
        hero: {
          type: 'object',
          assetOptions: { accept: ['image'] },
          properties: { _asset: { type: 'string' } },
        },
      },
    }
    expect(findAltRequiredPaths(schema)).toEqual([])
  })

  it('finds nested altRequired fields', () => {
    const schema = {
      type: 'object',
      properties: {
        cards: {
          type: 'object',
          properties: {
            image: {
              type: 'object',
              assetOptions: { altRequired: true },
              properties: { _asset: { type: 'string' } },
            },
          },
        },
      },
    }
    expect(findAltRequiredPaths(schema)).toEqual(['cards.image'])
  })

  it('finds altRequired inside array items', () => {
    const schema = {
      type: 'object',
      properties: {
        gallery: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              image: {
                type: 'object',
                assetOptions: { altRequired: true },
                properties: { _asset: { type: 'string' } },
              },
            },
          },
        },
      },
    }
    expect(findAltRequiredPaths(schema)).toEqual(['gallery[].image'])
  })

  it('finds multiple altRequired fields in one schema', () => {
    const schema = {
      type: 'object',
      properties: {
        hero: { assetOptions: { altRequired: true } },
        thumbnail: { assetOptions: { altRequired: true } },
        decorative: { assetOptions: { altRequired: false } },
      },
    }
    const paths = findAltRequiredPaths(schema).sort()
    expect(paths).toEqual(['hero', 'thumbnail'])
  })
})

describe('readAtPath', () => {
  it('reads a top-level field', () => {
    expect(readAtPath({ hero: { _asset: 'sun' } }, 'hero')).toEqual([{ _asset: 'sun' }])
  })

  it('reads a nested field', () => {
    expect(readAtPath({ cards: { image: { _asset: 'a' } } }, 'cards.image')).toEqual([{ _asset: 'a' }])
  })

  it('returns every item in an array path', () => {
    const value = { gallery: [{ image: { _asset: 'a' } }, { image: { _asset: 'b' } }] }
    expect(readAtPath(value, 'gallery[].image')).toEqual([{ _asset: 'a' }, { _asset: 'b' }])
  })

  it('returns empty array on missing path', () => {
    expect(readAtPath({}, 'nope.missing')).toEqual([])
  })

  it('handles <root> path', () => {
    expect(readAtPath({ x: 1 }, '<root>')).toEqual([{ x: 1 }])
  })

  it('handles undefined value gracefully', () => {
    expect(readAtPath(undefined, 'hero')).toEqual([])
  })
})
