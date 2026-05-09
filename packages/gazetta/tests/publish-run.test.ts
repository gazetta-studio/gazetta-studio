/**
 * Cut 1 — type contract scaffold for publishRun.
 *
 * Cut 1 ships types (`PublishRunInput`, `PublishRunResult`,
 * `PublishProgressEvent` union) and an unimplemented `publishRun`
 * shell. The body lands in Cut 5 by porting the orchestration from
 * `publish.ts` + `cli/index.ts:runPublish` + admin-api/routes/publish.
 *
 * These tests pin the type shape so Cut 5 can't quietly change the
 * contract.
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  publishRun,
  type PublishItemRef,
  type PublishProgressEvent,
  type PublishRunInput,
  type PublishRunResult,
  type PublishTargetResult,
} from '../src/publish-run.js'

describe('publishRun — Cut 1 shell', () => {
  it('throws "not implemented" until Cut 5 ports the spine', async () => {
    const input = {} as PublishRunInput
    await expect(publishRun(input)).rejects.toThrow(/not implemented/i)
  })
})

describe('PublishItemRef type contract', () => {
  it('carries kind + name + optional locale', () => {
    const ref: PublishItemRef = { kind: 'page', name: 'home' }
    expectTypeOf(ref.kind).toEqualTypeOf<'page' | 'fragment'>()
    expect(ref.locale).toBeUndefined()
    const localeRef: PublishItemRef = { kind: 'page', name: 'home', locale: 'fr' }
    expect(localeRef.locale).toBe('fr')
  })
})

describe('PublishTargetResult type contract', () => {
  it('discriminates failed vs succeeded; carries write counts', () => {
    const ok: PublishTargetResult = {
      name: 'staging',
      failed: false,
      filesWritten: 31,
      filesRemoved: 2,
    }
    expect(ok.failed).toBe(false)

    const failed: PublishTargetResult = {
      name: 'production',
      failed: true,
      failureReason: 'auth failed',
      filesWritten: 0,
      filesRemoved: 0,
    }
    expect(failed.failureReason).toBe('auth failed')
  })
})

describe('PublishRunResult type contract', () => {
  it('aggregates items + targets; ok derived', () => {
    const result: PublishRunResult = {
      ok: true,
      items: [],
      targets: [],
    }
    expectTypeOf(result.items).toEqualTypeOf<readonly import('../src/publish-item.js').PublishItemResult[]>()
    expectTypeOf(result.targets).toEqualTypeOf<readonly PublishTargetResult[]>()
  })
})

describe('PublishProgressEvent variants', () => {
  it('exhaustive switch on kind compiles', () => {
    const project = (e: PublishProgressEvent): string => {
      switch (e.kind) {
        case 'run-start':
          return `run ${e.totalItems}×${e.totalTargets}`
        case 'target-start':
          return `target-start ${e.target}`
        case 'item-start':
          return `item-start ${e.item.name}@${e.target}`
        case 'item-done':
          return `item-done ${e.result.name}`
        case 'target-done':
          return `target-done ${e.result.name}`
        case 'run-done':
          return `run-done ${e.result.ok}`
        // No default — adding a variant produces a TS error here.
      }
    }
    expect(project({ kind: 'run-start', totalItems: 5, totalTargets: 2 })).toBe('run 5×2')
    expect(project({ kind: 'target-start', target: 'staging' })).toBe('target-start staging')
  })
})
