/**
 * Cut 2 tests: hook dispatch — chain semantics, timeout,
 * fault isolation.
 *
 * Pinned invariants per design-hooks.md "Composition (Q3 locked)":
 *   - before* chain: output of N = input of N+1
 *   - before* throw → cancellation propagates; subsequent
 *     handlers don't fire
 *   - before* per-handler timeout fires HookTimeout
 *   - non-cancellation throw wraps as HookCancellation
 *   - after* parallel: every handler runs, even if siblings fail
 *   - after* failures logged via ctx.log; never propagated
 *   - after* timeout fires HookTimeout (logged, not propagated)
 *   - empty chain returns input unchanged
 */
import { describe, expect, it, vi } from 'vitest'
import {
  dispatchAfterLoad,
  dispatchAfterPublish,
  dispatchAfterSave,
  dispatchAfterUpload,
  dispatchBeforePublish,
  dispatchBeforeSave,
  dispatchBeforeUpload,
  HookCancellation,
  HookRegistry,
  HookTimeout,
} from '../src/hooks/index.js'
import type {
  AfterPublishHook,
  AfterSaveHook,
  AfterUploadHook,
  BeforePublishHook,
  BeforeSaveHook,
  BeforeUploadHook,
  HookContext,
  HookLogger,
  HookScope,
  PublishHookResult,
  PublishItem,
  ReadOnlySiteConfig,
  ReadOnlyStorageProvider,
  SaveResult,
  UploadHookAsset,
  UploadHookPayload,
  UploadHookResult,
} from '../src/hooks/index.js'

function makeLogger(): HookLogger & { errors: unknown[]; warns: unknown[] } {
  const errors: unknown[] = []
  const warns: unknown[] = []
  return {
    debug: () => {},
    info: () => {},
    warn: (obj, msg) => {
      warns.push({ obj, msg })
    },
    error: (obj, msg) => {
      errors.push({ obj, msg })
    },
    errors,
    warns,
  }
}

const READ_ONLY_STORAGE_STUB: ReadOnlyStorageProvider = {
  readFile: async () => '',
  readDir: async () => [],
  exists: async () => false,
  readBytes: async () => new Uint8Array(),
  readStream: async () => new ReadableStream(),
}

const SITE_STUB: ReadOnlySiteConfig = { name: 'test' }

function makeCtx(logger: HookLogger = makeLogger()): HookContext {
  return {
    principal: { id: 'alice', role: 'admin', trustMode: 'none', capabilities: ['*'] },
    target: 'local',
    requestId: 'req-1',
    now: new Date('2026-05-04T14:23:05Z'),
    log: logger,
    site: SITE_STUB,
    storage: READ_ONLY_STORAGE_STUB,
  }
}

const SCOPE: HookScope = { kind: 'page', name: 'home' }

describe('Cut 2 — dispatchBeforeSave chaining', () => {
  it('returns the input payload when no handlers registered', async () => {
    const r = new HookRegistry()
    const result = await dispatchBeforeSave(r, SCOPE, { title: 'Original' }, makeCtx())
    expect(result).toEqual({ title: 'Original' })
  })

  it('chains output of N as input of N+1', async () => {
    const r = new HookRegistry()
    const trim: BeforeSaveHook<{ title: string }> = async (_s, p, _c) => ({
      ...p,
      title: p.title.trim(),
    })
    const upper: BeforeSaveHook<{ title: string }> = async (_s, p, _c) => ({
      ...p,
      title: p.title.toUpperCase(),
    })
    r.register('beforeSave', trim as BeforeSaveHook, { priority: 50, name: 'trim' })
    r.register('beforeSave', upper as BeforeSaveHook, { priority: 100, name: 'upper' })
    const result = await dispatchBeforeSave(r, SCOPE, { title: '  hello  ' }, makeCtx())
    expect(result).toEqual({ title: 'HELLO' })
  })

  it('respects priority order across the chain', async () => {
    const r = new HookRegistry()
    const order: string[] = []
    const a: BeforeSaveHook = async (_s, p, _c) => {
      order.push('a')
      return p
    }
    const b: BeforeSaveHook = async (_s, p, _c) => {
      order.push('b')
      return p
    }
    const c: BeforeSaveHook = async (_s, p, _c) => {
      order.push('c')
      return p
    }
    // Register in non-priority order; dispatch should still walk
    // priority order.
    r.register('beforeSave', c, { priority: 1000, name: 'c' })
    r.register('beforeSave', a, { priority: 50, name: 'a' })
    r.register('beforeSave', b, { priority: 200, name: 'b' })
    await dispatchBeforeSave(r, SCOPE, {}, makeCtx())
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('throw in handler cancels the chain — subsequent handlers do not fire', async () => {
    const r = new HookRegistry()
    const seen: string[] = []
    const ok: BeforeSaveHook = async (_s, p, _c) => {
      seen.push('ok')
      return p
    }
    const bad: BeforeSaveHook = async () => {
      seen.push('bad')
      throw new Error('cannot save')
    }
    const after: BeforeSaveHook = async (_s, p, _c) => {
      seen.push('after')
      return p
    }
    r.register('beforeSave', ok, { priority: 50, name: 'ok' })
    r.register('beforeSave', bad, { priority: 100, name: 'bad' })
    r.register('beforeSave', after, { priority: 200, name: 'after' })
    await expect(dispatchBeforeSave(r, SCOPE, {}, makeCtx())).rejects.toBeInstanceOf(HookCancellation)
    // 'after' did not run
    expect(seen).toEqual(['ok', 'bad'])
  })

  it('wraps non-cancellation errors as HookCancellation with cause', async () => {
    const r = new HookRegistry()
    const original = new TypeError('something went wrong')
    const bad: BeforeSaveHook = async () => {
      throw original
    }
    r.register('beforeSave', bad, { name: 'bad' })
    try {
      await dispatchBeforeSave(r, SCOPE, {}, makeCtx())
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(HookCancellation)
      const c = err as HookCancellation
      expect(c.hookName).toBe('bad')
      expect(c.phase).toBe('beforeSave')
      expect(c.cause).toBe(original)
      expect(c.message).toContain('something went wrong')
    }
  })

  it('preserves HookCancellation thrown directly by a handler', async () => {
    const r = new HookRegistry()
    const explicit = new HookCancellation({
      hookName: 'self-cancel',
      phase: 'beforeSave',
      message: 'explicit cancel',
    })
    const bad: BeforeSaveHook = async () => {
      throw explicit
    }
    r.register('beforeSave', bad, { name: 'self-cancel' })
    await expect(dispatchBeforeSave(r, SCOPE, {}, makeCtx())).rejects.toBe(explicit)
  })

  it('per-handler timeout fires HookTimeout', async () => {
    const r = new HookRegistry()
    const slow: BeforeSaveHook = async (_s, p, _c) => new Promise(resolve => setTimeout(() => resolve(p), 200))
    r.register('beforeSave', slow, { name: 'slow', timeout: 50 })
    try {
      await dispatchBeforeSave(r, SCOPE, {}, makeCtx())
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(HookTimeout)
      const t = err as HookTimeout
      expect(t.hookName).toBe('slow')
      expect(t.timeoutMs).toBe(50)
    }
  })

  it('fast handler under timeout completes normally', async () => {
    const r = new HookRegistry()
    const fast: BeforeSaveHook<{ title: string }> = async (_s, p, _c) => ({
      ...p,
      title: 'fast',
    })
    r.register('beforeSave', fast as BeforeSaveHook, { name: 'fast', timeout: 5000 })
    const result = await dispatchBeforeSave(r, SCOPE, { title: 'orig' }, makeCtx())
    expect(result).toEqual({ title: 'fast' })
  })
})

describe('Cut 2 — dispatchAfterSave parallel + fail-open', () => {
  it('runs all handlers even when one fails', async () => {
    const r = new HookRegistry()
    const ran: string[] = []
    const ok: AfterSaveHook = async () => {
      ran.push('ok')
    }
    const bad: AfterSaveHook = async () => {
      ran.push('bad')
      throw new Error('boom')
    }
    const okAlso: AfterSaveHook = async () => {
      ran.push('okAlso')
    }
    r.register('afterSave', ok, { name: 'ok' })
    r.register('afterSave', bad, { name: 'bad' })
    r.register('afterSave', okAlso, { name: 'okAlso' })

    const logger = makeLogger()
    const result: SaveResult<{ title: string }> = { payload: { title: 'Hi' } }
    await dispatchAfterSave(r, SCOPE, result, makeCtx(logger))
    expect(ran).toEqual(['ok', 'bad', 'okAlso'])
    // Failure logged
    expect(logger.errors).toHaveLength(1)
    const entry = logger.errors[0] as { obj: { hookName: string }; msg: string }
    expect(entry.obj.hookName).toBe('bad')
    expect(entry.msg).toContain('Hook "bad" failed')
  })

  it('does not throw even when every handler fails', async () => {
    const r = new HookRegistry()
    const bad: AfterSaveHook = async () => {
      throw new Error('boom')
    }
    r.register('afterSave', bad, { name: 'a' })
    r.register('afterSave', bad, { name: 'b' })
    const logger = makeLogger()
    await expect(dispatchAfterSave(r, SCOPE, { payload: {} }, makeCtx(logger))).resolves.toBeUndefined()
    expect(logger.errors).toHaveLength(2)
  })

  it('after* timeout logs HookTimeout but does not throw', async () => {
    const r = new HookRegistry()
    const slow: AfterSaveHook = async () => new Promise(resolve => setTimeout(resolve, 200))
    r.register('afterSave', slow, { name: 'slow', timeout: 50 })
    const logger = makeLogger()
    await expect(dispatchAfterSave(r, SCOPE, { payload: {} }, makeCtx(logger))).resolves.toBeUndefined()
    expect(logger.errors).toHaveLength(1)
    const entry = logger.errors[0] as { obj: { timeout: boolean; hookName: string } }
    expect(entry.obj.timeout).toBe(true)
    expect(entry.obj.hookName).toBe('slow')
  })

  it('empty chain resolves immediately without log writes', async () => {
    const r = new HookRegistry()
    const logger = makeLogger()
    await dispatchAfterSave(r, SCOPE, { payload: {} }, makeCtx(logger))
    expect(logger.errors).toHaveLength(0)
    expect(logger.warns).toHaveLength(0)
  })

  it('runs handlers in parallel — total time bounded by slowest, not sum', async () => {
    const r = new HookRegistry()
    const slowOk: AfterSaveHook = async () => new Promise(resolve => setTimeout(resolve, 100))
    r.register('afterSave', slowOk, { name: 'a', timeout: 5000 })
    r.register('afterSave', slowOk, { name: 'b', timeout: 5000 })
    r.register('afterSave', slowOk, { name: 'c', timeout: 5000 })
    const start = Date.now()
    await dispatchAfterSave(r, SCOPE, { payload: {} }, makeCtx())
    const elapsed = Date.now() - start
    // 3 × 100ms in serial would be ~300ms; parallel should be ~100ms.
    // Generous bound to avoid CI flake: parallel < 250ms.
    expect(elapsed).toBeLessThan(250)
  })
})

describe('Cut 2 — dispatchAfterLoad chains like beforeSave', () => {
  it('chains output of N as input of N+1', async () => {
    const r = new HookRegistry()
    r.register('afterLoad', async (_s, p: { v: number }, _c) => ({ ...p, v: p.v + 1 }), {
      priority: 50,
      name: 'inc',
    })
    r.register('afterLoad', async (_s, p: { v: number }, _c) => ({ ...p, v: p.v * 2 }), {
      priority: 100,
      name: 'double',
    })
    const result = await dispatchAfterLoad(r, SCOPE, { v: 5 }, makeCtx())
    expect(result).toEqual({ v: 12 }) // (5+1) * 2
  })
})

describe('Cut 2 — publish dispatch', () => {
  it('beforePublish chains items through handlers', async () => {
    const r = new HookRegistry()
    const dropAssets: BeforePublishHook = async (_t, items, _c) => items.filter(i => i.kind !== 'asset')
    r.register('beforePublish', dropAssets, { name: 'drop-assets' })
    const items: PublishItem[] = [
      { kind: 'page', name: 'home', path: 'pages/home/page.json' },
      { kind: 'asset', name: 'hero', path: 'assets/hero.asset.json' },
    ]
    const out = await dispatchBeforePublish(r, 'production', items, makeCtx())
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('page')
  })

  it('afterPublish parallel + fail-open', async () => {
    const r = new HookRegistry()
    const fired: string[] = []
    const ok: AfterPublishHook = async () => {
      fired.push('a')
    }
    const bad: AfterPublishHook = async () => {
      fired.push('b')
      throw new Error('partial fail')
    }
    r.register('afterPublish', ok, { name: 'a' })
    r.register('afterPublish', bad, { name: 'b' })
    const result: PublishHookResult = {
      target: 'production',
      itemsPublished: [],
      itemsFailed: [],
    }
    const logger = makeLogger()
    await dispatchAfterPublish(r, 'production', result, makeCtx(logger))
    expect(fired).toEqual(['a', 'b'])
    expect(logger.errors).toHaveLength(1)
  })
})

describe('Cut 2 — upload dispatch', () => {
  it('beforeUpload chains asset + bytes through handlers', async () => {
    const r = new HookRegistry()
    const enrichAlt: BeforeUploadHook = async (asset, bytes, _c) => ({
      asset: { ...asset, alt: 'auto-generated' },
      bytes,
    })
    const stripExif: BeforeUploadHook = async (asset, bytes, _c) => ({
      asset,
      bytes: bytes.slice(2), // pretend to strip a 2-byte EXIF marker
    })
    r.register('beforeUpload', enrichAlt, { priority: 50, name: 'alt' })
    r.register('beforeUpload', stripExif, { priority: 100, name: 'strip' })

    const asset: UploadHookAsset = { name: 'hero', mime: 'image/jpeg', size: 5 }
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const out: UploadHookPayload = await dispatchBeforeUpload(r, asset, bytes, makeCtx())
    expect(out.asset.alt).toBe('auto-generated')
    expect(out.bytes).toEqual(new Uint8Array([3, 4, 5]))
  })

  it('afterUpload parallel + fail-open', async () => {
    const r = new HookRegistry()
    const fired: string[] = []
    const cdnWarmer: AfterUploadHook = async () => {
      fired.push('cdn-warmer')
    }
    const thumbGen: AfterUploadHook = async () => {
      fired.push('thumb-gen')
      throw new Error('thumbnailer down')
    }
    r.register('afterUpload', cdnWarmer, { name: 'cdn-warmer' })
    r.register('afterUpload', thumbGen, { name: 'thumb-gen' })
    const asset: UploadHookAsset = { name: 'hero', mime: 'image/jpeg', size: 100 }
    const result: UploadHookResult = { asset, hash: 'a3b2c1d4' }
    const logger = makeLogger()
    await dispatchAfterUpload(r, asset, result, makeCtx(logger))
    expect(fired).toEqual(['cdn-warmer', 'thumb-gen'])
    expect(logger.errors).toHaveLength(1)
  })
})

describe('Cut 2 — context passing', () => {
  it('hooks receive the same HookContext instance', async () => {
    const r = new HookRegistry()
    const captured: HookContext[] = []
    const cap: BeforeSaveHook = async (_s, p, ctx) => {
      captured.push(ctx)
      return p
    }
    r.register('beforeSave', cap, { name: 'a' })
    r.register('beforeSave', cap, { name: 'b' })
    const ctx = makeCtx()
    await dispatchBeforeSave(r, SCOPE, {}, ctx)
    expect(captured[0]).toBe(ctx)
    expect(captured[1]).toBe(ctx)
  })

  it('hooks receive the scope as first arg unchanged', async () => {
    const r = new HookRegistry()
    const seen: HookScope[] = []
    const cap: BeforeSaveHook = async (scope, p, _c) => {
      seen.push(scope)
      return p
    }
    r.register('beforeSave', cap, { name: 'a' })
    const scope: HookScope = { kind: 'page', name: 'home', locale: 'fr' }
    await dispatchBeforeSave(r, scope, {}, makeCtx())
    expect(seen[0]).toEqual(scope)
  })
})

describe('Cut 2 — dispatchBeforeSave does not call handlers when chain is empty', () => {
  it('dispatch is a fast no-op when phase has no handlers', async () => {
    const r = new HookRegistry()
    r.register('afterSave', async () => {}, { name: 'unrelated' })
    const spy = vi.fn()
    // Deliberately do NOT register on beforeSave; verify spy never fires
    const result = await dispatchBeforeSave(r, SCOPE, { x: spy }, makeCtx())
    expect(result).toEqual({ x: spy })
    expect(spy).not.toHaveBeenCalled()
  })
})
