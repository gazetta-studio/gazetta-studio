/**
 * Cut 1 tests: hooks foundation types + error taxonomy.
 *
 * Type-level checks (per design-hooks.md "Cut 1: Infrastructure" —
 * 'Tests: type-level checks only'):
 *
 *   - Each handler signature matches the design's locked shape
 *   - HookHandler<P> re-narrows to the phase-specific signature
 *   - Error classes preserve instanceof chains for catch-all
 *     handling
 *
 * Runtime checks for the error classes (since they have constructors):
 *   - HookCancellation captures hookName, phase, optional cause
 *   - HookTimeout captures hookName, phase, timeoutMs
 *   - RegistrationAfterInitError captures source, phase
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  AfterLoadHook,
  AfterPublishHook,
  AfterSaveHook,
  AfterUploadHook,
  BeforePublishHook,
  BeforeSaveHook,
  BeforeUploadHook,
  HookContext,
  HookHandler,
  HookPhase,
  HookRegistration,
  HookScope,
  PublishHookResult,
  PublishItem,
  ReadOnlyStorageProvider,
  SaveResult,
  UploadHookAsset,
  UploadHookPayload,
  UploadHookResult,
} from '../src/hooks/index.js'
import { HookCancellation, HookError, HookTimeout, RegistrationAfterInitError } from '../src/hooks/index.js'

describe('Cut 1 — type vocabulary', () => {
  it('HookPhase enumerates v1 lifecycle phases', () => {
    // Type-level check: every v1 phase is in the union. The
    // assertion compiles only when each name matches the union;
    // adding/removing phases changes this list intentionally.
    const phases: HookPhase[] = [
      'beforeSave',
      'afterSave',
      'afterLoad',
      'beforePublish',
      'afterPublish',
      'beforeUpload',
      'afterUpload',
    ]
    expect(phases).toHaveLength(7)
  })

  it('HookHandler<P> re-narrows to phase-specific signatures', () => {
    type Save = HookHandler<'beforeSave'>
    type AfterSave = HookHandler<'afterSave'>
    type Publish = HookHandler<'beforePublish'>
    type AfterUpload = HookHandler<'afterUpload'>
    expectTypeOf<Save>().toEqualTypeOf<BeforeSaveHook>()
    expectTypeOf<AfterSave>().toEqualTypeOf<AfterSaveHook>()
    expectTypeOf<Publish>().toEqualTypeOf<BeforePublishHook>()
    expectTypeOf<AfterUpload>().toEqualTypeOf<AfterUploadHook>()
  })
})

describe('Cut 1 — handler signatures', () => {
  // These tests construct concrete handler implementations to
  // verify the signature compiles. The handlers are not invoked;
  // the assertion is "this code type-checks."
  it('BeforeSaveHook<T> returns mutated payload', () => {
    interface Payload {
      title: string
    }
    const hook: BeforeSaveHook<Payload> = async (scope, payload, _ctx) => {
      void scope
      return { ...payload, title: payload.title.trim() }
    }
    expect(typeof hook).toBe('function')
  })

  it('AfterSaveHook<T> returns void', () => {
    interface Payload {
      title: string
    }
    const hook: AfterSaveHook<Payload> = async (_scope, _result, _ctx) => {
      // observe-only
    }
    expect(typeof hook).toBe('function')
  })

  it('AfterLoadHook<T> returns mutated payload (read-time enrichment)', () => {
    interface Payload {
      title: string
    }
    const hook: AfterLoadHook<Payload> = async (_scope, payload, _ctx) => {
      return { ...payload, title: payload.title.toUpperCase() }
    }
    expect(typeof hook).toBe('function')
  })

  it('BeforePublishHook returns mutated PublishItem array', () => {
    const hook: BeforePublishHook = async (_target, items, _ctx) => {
      return items.filter(item => item.kind !== 'asset')
    }
    expect(typeof hook).toBe('function')
  })

  it('AfterPublishHook returns void', () => {
    const hook: AfterPublishHook = async (_target, _result, _ctx) => {
      // observe-only
    }
    expect(typeof hook).toBe('function')
  })

  it('BeforeUploadHook returns UploadHookPayload (asset + bytes)', () => {
    const hook: BeforeUploadHook = async (asset, bytes, _ctx) => {
      return { asset: { ...asset, alt: 'auto-generated' }, bytes }
    }
    expect(typeof hook).toBe('function')
  })

  it('AfterUploadHook returns void', () => {
    const hook: AfterUploadHook = async (_asset, _result, _ctx) => {
      // observe-only
    }
    expect(typeof hook).toBe('function')
  })
})

describe('Cut 1 — narrow ReadOnlyStorageProvider', () => {
  it('exposes only read methods', () => {
    // Type-level check: ReadOnlyStorageProvider must have read
    // methods and must NOT have write methods. The assertions
    // compile only when the shape matches.
    expectTypeOf<ReadOnlyStorageProvider>().toHaveProperty('readFile')
    expectTypeOf<ReadOnlyStorageProvider>().toHaveProperty('readDir')
    expectTypeOf<ReadOnlyStorageProvider>().toHaveProperty('exists')
    expectTypeOf<ReadOnlyStorageProvider>().toHaveProperty('readBytes')
    expectTypeOf<ReadOnlyStorageProvider>().toHaveProperty('readStream')
    expectTypeOf<ReadOnlyStorageProvider>().not.toHaveProperty('writeFile')
    expectTypeOf<ReadOnlyStorageProvider>().not.toHaveProperty('writeBytes')
    expectTypeOf<ReadOnlyStorageProvider>().not.toHaveProperty('writeStream')
    expectTypeOf<ReadOnlyStorageProvider>().not.toHaveProperty('mkdir')
    expectTypeOf<ReadOnlyStorageProvider>().not.toHaveProperty('rm')
  })
})

describe('Cut 1 — payload types', () => {
  it('HookScope captures kind + name + dimension hints', () => {
    const scope: HookScope = { kind: 'page', name: 'home', locale: 'fr', theme: 'dark' }
    expect(scope.kind).toBe('page')
    expect(scope.name).toBe('home')
    expect(scope.locale).toBe('fr')
    expect(scope.theme).toBe('dark')
  })

  it('SaveResult<T> exposes payload + optional etag', () => {
    interface Payload {
      title: string
    }
    const result: SaveResult<Payload> = { payload: { title: 'Hi' }, etag: 'abc123' }
    expect(result.payload.title).toBe('Hi')
    expect(result.etag).toBe('abc123')
  })

  it('PublishItem captures kind + name + path', () => {
    const item: PublishItem = { kind: 'page', name: 'home', path: 'pages/home/page.json' }
    expect(item.kind).toBe('page')
  })

  it('PublishHookResult captures the published + failed sets', () => {
    const item: PublishItem = { kind: 'page', name: 'home', path: 'pages/home/page.json' }
    const result: PublishHookResult = {
      target: 'production',
      itemsPublished: [item],
      itemsFailed: [],
    }
    expect(result.target).toBe('production')
    expect(result.itemsPublished).toHaveLength(1)
  })

  it('UploadHookAsset / Payload / Result form the upload chain', () => {
    const asset: UploadHookAsset = { name: 'hero', mime: 'image/jpeg', size: 1024 }
    const bytes = new Uint8Array([1, 2, 3])
    const payload: UploadHookPayload = { asset, bytes }
    const result: UploadHookResult = { asset, hash: 'a3b2c1d4' }
    expect(payload.asset.name).toBe('hero')
    expect(result.hash).toBe('a3b2c1d4')
  })
})

describe('Cut 1 — error taxonomy', () => {
  it('HookCancellation extends HookError + Error', () => {
    const err = new HookCancellation({
      hookName: 'auto-slugify',
      phase: 'beforeSave',
      message: 'cancelled by validator',
    })
    expect(err).toBeInstanceOf(HookCancellation)
    expect(err).toBeInstanceOf(HookError)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('HookCancellation')
    expect(err.hookName).toBe('auto-slugify')
    expect(err.phase).toBe('beforeSave')
    expect(err.message).toBe('cancelled by validator')
  })

  it('HookCancellation captures cause for handler crashes', () => {
    const original = new Error('handler crashed')
    const err = new HookCancellation({
      hookName: 'auto-slugify',
      phase: 'beforeSave',
      cause: original,
    })
    expect(err.cause).toBe(original)
    // Default message when none supplied
    expect(err.message).toContain('auto-slugify')
    expect(err.message).toContain('beforeSave')
  })

  it('HookTimeout captures hookName + phase + timeout', () => {
    const err = new HookTimeout({
      hookName: 'slow-enrichment',
      phase: 'beforeSave',
      timeoutMs: 5000,
    })
    expect(err).toBeInstanceOf(HookTimeout)
    expect(err).toBeInstanceOf(HookError)
    expect(err.hookName).toBe('slow-enrichment')
    expect(err.timeoutMs).toBe(5000)
    expect(err.message).toContain('5000ms')
  })

  it('RegistrationAfterInitError names the source and phase', () => {
    const err = new RegistrationAfterInitError({
      source: '@gazetta/slack-notify',
      phase: 'afterPublish',
    })
    expect(err).toBeInstanceOf(RegistrationAfterInitError)
    expect(err).toBeInstanceOf(HookError)
    expect(err.source).toBe('@gazetta/slack-notify')
    expect(err.phase).toBe('afterPublish')
    expect(err.message).toContain('@gazetta/slack-notify')
    expect(err.message).toContain('afterPublish')
  })

  it('HookError catch-all covers every subclass', () => {
    const errors: HookError[] = [
      new HookCancellation({ hookName: 'a', phase: 'beforeSave' }),
      new HookTimeout({ hookName: 'b', phase: 'beforeSave', timeoutMs: 1000 }),
      new RegistrationAfterInitError({ source: 'c', phase: 'beforeSave' }),
    ]
    for (const err of errors) {
      expect(err).toBeInstanceOf(HookError)
    }
  })
})

describe('Cut 1 — registration metadata', () => {
  it('HookRegistration<P> ties handler type to phase', () => {
    const handler: BeforeSaveHook = async (_scope, payload, _ctx) => payload
    const reg: HookRegistration<'beforeSave'> = {
      phase: 'beforeSave',
      handler,
      priority: 1000,
      name: 'auto-slugify',
      timeout: 5000,
      sequence: 0,
      source: 'site-local',
    }
    expect(reg.phase).toBe('beforeSave')
    expect(reg.priority).toBe(1000)
    expect(reg.name).toBe('auto-slugify')
  })
})

describe('Cut 1 — HookContext shape', () => {
  // No runtime instantiation possible without the dispatcher (Cut
  // 2 builds HookContext from request data). Verify the shape via
  // type-level assertions only.
  it('exposes principal + target + requestId + now + log + site + storage', () => {
    expectTypeOf<HookContext>().toHaveProperty('principal')
    expectTypeOf<HookContext>().toHaveProperty('target')
    expectTypeOf<HookContext>().toHaveProperty('requestId')
    expectTypeOf<HookContext>().toHaveProperty('now')
    expectTypeOf<HookContext>().toHaveProperty('log')
    expectTypeOf<HookContext>().toHaveProperty('site')
    expectTypeOf<HookContext>().toHaveProperty('storage')
  })

  it('storage is the read-only subset', () => {
    expectTypeOf<HookContext['storage']>().toEqualTypeOf<ReadOnlyStorageProvider>()
  })
})
