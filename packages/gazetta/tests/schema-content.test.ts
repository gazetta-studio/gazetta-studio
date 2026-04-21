/**
 * Type-level tests for the `Content<T>` mapper. These verify the mapper
 * correctly swaps reference types for resolved types in Zod-inferred content
 * shapes. Uses Vitest's `expectTypeOf` (no runtime assertions — the type
 * checker is the test).
 */
import { expectTypeOf, describe, it } from 'vitest'
import { z } from 'zod'
import { downloadable, embeddedAsset, fontAsset } from '../src/schema/helpers.js'
import type {
  Content,
  ResolvedDownloadableAsset,
  ResolvedEmbeddedAsset,
  ResolvedFontAsset,
} from '../src/schema/types.js'

describe('Content<T> — swaps asset refs for resolved types', () => {
  it('swaps a top-level embeddedAsset reference', () => {
    const schema = z.object({
      hero: embeddedAsset({ accept: ['image'] }),
      title: z.string(),
    })
    type Raw = z.infer<typeof schema>
    type Resolved = Content<Raw>

    expectTypeOf<Resolved['hero']>().toEqualTypeOf<ResolvedEmbeddedAsset>()
    expectTypeOf<Resolved['title']>().toEqualTypeOf<string>()
  })

  it('swaps a top-level downloadable reference', () => {
    const schema = z.object({
      brochure: downloadable(),
    })
    type Resolved = Content<z.infer<typeof schema>>
    expectTypeOf<Resolved['brochure']>().toEqualTypeOf<ResolvedDownloadableAsset>()
  })

  it('swaps a top-level fontAsset reference', () => {
    const schema = z.object({
      bodyFont: fontAsset(),
    })
    type Resolved = Content<z.infer<typeof schema>>
    expectTypeOf<Resolved['bodyFont']>().toEqualTypeOf<ResolvedFontAsset>()
  })

  it('recurses into nested objects', () => {
    const schema = z.object({
      hero: z.object({
        image: embeddedAsset(),
        caption: z.string(),
      }),
    })
    type Resolved = Content<z.infer<typeof schema>>
    expectTypeOf<Resolved['hero']['image']>().toEqualTypeOf<ResolvedEmbeddedAsset>()
    expectTypeOf<Resolved['hero']['caption']>().toEqualTypeOf<string>()
  })

  it('recurses into arrays', () => {
    const schema = z.object({
      gallery: z.array(embeddedAsset({ accept: ['image'] })),
    })
    type Resolved = Content<z.infer<typeof schema>>
    // Array element swapped — each entry is a resolved embedded asset.
    expectTypeOf<Resolved['gallery'][number]>().toEqualTypeOf<ResolvedEmbeddedAsset>()
  })

  it('handles mixed asset kinds in one schema', () => {
    const schema = z.object({
      hero: embeddedAsset({ accept: ['image'] }),
      whitepaper: downloadable(),
      display: fontAsset(),
      body: z.string(),
    })
    type Resolved = Content<z.infer<typeof schema>>
    expectTypeOf<Resolved['hero']>().toEqualTypeOf<ResolvedEmbeddedAsset>()
    expectTypeOf<Resolved['whitepaper']>().toEqualTypeOf<ResolvedDownloadableAsset>()
    expectTypeOf<Resolved['display']>().toEqualTypeOf<ResolvedFontAsset>()
    expectTypeOf<Resolved['body']>().toEqualTypeOf<string>()
  })

  it('preserves optionality on fields', () => {
    const schema = z.object({
      hero: embeddedAsset().optional(),
      title: z.string().optional(),
    })
    type Resolved = Content<z.infer<typeof schema>>
    // Optional embeddedAsset → optional resolved (union with undefined)
    expectTypeOf<Resolved['hero']>().toEqualTypeOf<ResolvedEmbeddedAsset | undefined>()
    expectTypeOf<Resolved['title']>().toEqualTypeOf<string | undefined>()
  })

  it('preserves primitives unchanged', () => {
    type Resolved = Content<{
      s: string
      n: number
      b: boolean
      nil: null
      u: undefined
    }>
    expectTypeOf<Resolved['s']>().toEqualTypeOf<string>()
    expectTypeOf<Resolved['n']>().toEqualTypeOf<number>()
    expectTypeOf<Resolved['b']>().toEqualTypeOf<boolean>()
    expectTypeOf<Resolved['nil']>().toEqualTypeOf<null>()
    expectTypeOf<Resolved['u']>().toEqualTypeOf<undefined>()
  })

  it('preserves an array of primitives unchanged', () => {
    type Resolved = Content<{ tags: string[] }>
    expectTypeOf<Resolved['tags']>().toEqualTypeOf<ReadonlyArray<string>>()
  })
})
