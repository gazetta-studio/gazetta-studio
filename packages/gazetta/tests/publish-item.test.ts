/**
 * Cut 1 — type contract scaffold for publishItemCore.
 *
 * Cut 1 ships types (`PublishItemInput`, `PublishItemResult` union,
 * `PublishRenderMode` enum) and an unimplemented `publishItemCore`
 * shell. The body lands in Cut 3 by porting the spine from
 * `publish-rendered.ts`.
 *
 * These tests pin the type shape so Cut 3 can't quietly change the
 * contract. Each `PublishItemResult` variant is the discriminator
 * surface routes/CLI will project to wire shape — adding a variant
 * must be deliberate (compile error at every consumer).
 *
 * Per team-preferences rule 26 (test-isolation paranoia): no
 * module-level state.
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  publishItemCore,
  type PublishItemInput,
  type PublishItemKind,
  type PublishItemNotFound,
  type PublishItemOk,
  type PublishItemRenderFailed,
  type PublishItemResult,
  type PublishItemStorageWriteFailed,
  type PublishItemTemplateInvalid,
  type PublishItemValidationFailed,
  type PublishRenderMode,
} from '../src/publish-item.js'

describe('publishItemCore — Cut 1 shell', () => {
  it('throws "not implemented" until Cut 3 ports the spine', async () => {
    const input = {} as PublishItemInput
    await expect(publishItemCore(input)).rejects.toThrow(/not implemented/i)
  })
})

describe('PublishItemKind type contract', () => {
  it('discriminator covers page + fragment', () => {
    expectTypeOf<PublishItemKind>().toEqualTypeOf<'page' | 'fragment'>()
  })
})

describe('PublishRenderMode type contract', () => {
  it('covers four modes locked in Q2', () => {
    expectTypeOf<PublishRenderMode>().toEqualTypeOf<
      'page-rendered' | 'page-static' | 'fragment-rendered' | 'archive-marker'
    >()
  })
})

describe('PublishItemResult variants', () => {
  it('PublishItemOk carries mode + files + removed', () => {
    const ok: PublishItemOk = {
      kind: 'page',
      name: 'home',
      ok: true,
      mode: 'page-rendered',
      files: 3,
      removed: 1,
    }
    expectTypeOf(ok.ok).toEqualTypeOf<true>()
    expectTypeOf(ok.mode).toEqualTypeOf<PublishRenderMode>()
    expect(ok.files).toBe(3)
  })

  it('PublishItemNotFound discriminates with code', () => {
    const failed: PublishItemNotFound = {
      kind: 'page',
      name: 'missing',
      ok: false,
      code: 'NOT_FOUND',
      reason: 'Page "missing" not found in source',
    }
    expectTypeOf(failed.code).toEqualTypeOf<'NOT_FOUND'>()
  })

  it('PublishItemRenderFailed discriminates with code', () => {
    const failed: PublishItemRenderFailed = {
      kind: 'fragment',
      name: 'header',
      ok: false,
      code: 'RENDER_FAILED',
      reason: 'Template threw during SSR',
    }
    expectTypeOf(failed.code).toEqualTypeOf<'RENDER_FAILED'>()
  })

  it('PublishItemTemplateInvalid discriminates with code', () => {
    const failed: PublishItemTemplateInvalid = {
      kind: 'page',
      name: 'about',
      ok: false,
      code: 'TEMPLATE_INVALID',
      reason: 'Template "page-default" failed scan',
    }
    expectTypeOf(failed.code).toEqualTypeOf<'TEMPLATE_INVALID'>()
  })

  it('PublishItemValidationFailed carries readonly Issue list', () => {
    const failed: PublishItemValidationFailed = {
      kind: 'page',
      name: 'home',
      ok: false,
      code: 'VALIDATION_FAILED',
      issues: [],
    }
    expectTypeOf(failed.code).toEqualTypeOf<'VALIDATION_FAILED'>()
  })

  it('PublishItemStorageWriteFailed discriminates with code', () => {
    const failed: PublishItemStorageWriteFailed = {
      kind: 'page',
      name: 'blog/post-1',
      ok: false,
      code: 'STORAGE_WRITE_FAILED',
      reason: 'R2 PUT failed after 3 retries',
    }
    expectTypeOf(failed.code).toEqualTypeOf<'STORAGE_WRITE_FAILED'>()
  })

  it('union narrows exhaustively on ok + code', () => {
    // Compile-time check: switch is exhaustive
    const project = (r: PublishItemResult): string => {
      if (r.ok) return 'success'
      switch (r.code) {
        case 'NOT_FOUND':
          return '404'
        case 'RENDER_FAILED':
          return 'render'
        case 'TEMPLATE_INVALID':
          return 'template'
        case 'VALIDATION_FAILED':
          return 'validation'
        case 'STORAGE_WRITE_FAILED':
          return 'storage'
        // No default — adding a variant produces a TS error here.
      }
    }
    expect(project({ kind: 'page', name: 'x', ok: true, mode: 'page-rendered', files: 0, removed: 0 })).toBe('success')
    expect(project({ kind: 'page', name: 'x', ok: false, code: 'NOT_FOUND', reason: '' })).toBe('404')
  })
})
