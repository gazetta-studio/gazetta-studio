/**
 * Hook dispatch — chains `before*` handlers, fans out `after*`
 * handlers, enforces per-handler timeout.
 *
 * Per design-hooks.md "Composition (Q3 locked)":
 *
 *   - `before*` chain: output of handler N = input of handler N+1.
 *     Final output proceeds to the operation. One handler throws
 *     → operation cancels; subsequent handlers don't fire.
 *   - `after*` parallel: each handler receives the same operation
 *     result. Independent (no chaining). Failures logged but
 *     don't stop other `after*` handlers from running.
 *   - Per-hook timeout (default 5s, configurable per registration):
 *     `before*` timeout = throw = cancel operation; `after*`
 *     timeout = logged + counted; chain continues.
 *
 * # Why two dispatch functions, not one
 *
 * `dispatchBefore` returns `Promise<T>` (the chained payload).
 * `dispatchAfter` returns `Promise<void>` (nothing to chain).
 * Same generic shape would force `dispatchAfter` consumers to
 * discard a meaningless return value, and `dispatchBefore`'s
 * cancellation semantics would force `after*` callers to handle
 * a throw they can never produce. Two functions, two contracts.
 *
 * # Timeout implementation
 *
 * `Promise.race(handler, timeoutPromise)` where the timeout
 * promise rejects with `HookTimeout`. The handler may still be
 * resolving in the background after timeout — Node's process
 * keeps running until handles drain. v1 doesn't `AbortController`
 * the handler; the design notes this as acceptable for v1
 * (handler completion after timeout is harmless because the
 * dispatcher already moved on).
 *
 * # Promise.allSettled vs Promise.all for `after*`
 *
 * `allSettled` so one failing handler doesn't prevent siblings
 * from firing. Each rejection is logged via `ctx.log.error` with
 * the hook name + phase + duration. The dispatcher itself never
 * rejects from `dispatchAfter`.
 *
 * # SOLID lenses
 *
 *   - SRP: dispatch owns the orchestration logic. Per-handler
 *     timeout is one concern (private helper). Cancellation
 *     wrapping is one concern (private helper).
 *   - DIP: callers depend on the dispatch functions; the
 *     registry's storage layout is opaque.
 *   - LSP: every dispatcher behaves identically across phases.
 */
import { HookCancellation, HookTimeout } from './errors.js'
import type { HookRegistry } from './registry.js'
import type {
  AfterLoadHook,
  AfterPublishHook,
  AfterSaveHook,
  AfterUploadHook,
  BeforePublishHook,
  BeforeSaveHook,
  BeforeUploadHook,
  HookContext,
  HookPhase,
  HookRegistration,
  HookScope,
  PublishHookResult,
  PublishItem,
  SaveResult,
  UploadHookAsset,
  UploadHookPayload,
  UploadHookResult,
} from './types.js'

/**
 * Chain `beforeSave` handlers. Returns the final payload after
 * every handler has run (or throws `HookCancellation` on first
 * failing handler).
 */
export async function dispatchBeforeSave<T>(
  registry: HookRegistry,
  scope: HookScope,
  payload: T,
  ctx: HookContext,
): Promise<T> {
  const handlers = registry.getByPhase('beforeSave')
  let current = payload
  for (const reg of handlers) {
    current = await runWithTimeout('beforeSave', reg as HookRegistration<'beforeSave'>, async () =>
      (reg.handler as BeforeSaveHook<T>)(scope, current, ctx),
    )
  }
  return current
}

/**
 * Fan out `afterSave` handlers in parallel. Failures logged;
 * never propagated.
 */
export async function dispatchAfterSave<T>(
  registry: HookRegistry,
  scope: HookScope,
  result: SaveResult<T>,
  ctx: HookContext,
): Promise<void> {
  const handlers = registry.getByPhase('afterSave')
  await runAfterChain(handlers, ctx, async reg => (reg.handler as AfterSaveHook<T>)(scope, result, ctx))
}

/**
 * Chain `afterLoad` handlers. Although the phase fires after
 * load (not before save), it's a mutating chain: each handler
 * may transform the loaded payload. Same shape as `beforeSave`.
 */
export async function dispatchAfterLoad<T>(
  registry: HookRegistry,
  scope: HookScope,
  payload: T,
  ctx: HookContext,
): Promise<T> {
  const handlers = registry.getByPhase('afterLoad')
  let current = payload
  for (const reg of handlers) {
    current = await runWithTimeout('afterLoad', reg as HookRegistration<'afterLoad'>, async () =>
      (reg.handler as AfterLoadHook<T>)(scope, current, ctx),
    )
  }
  return current
}

/**
 * Chain `beforePublish` handlers. Returns the final item array.
 */
export async function dispatchBeforePublish(
  registry: HookRegistry,
  target: string,
  items: ReadonlyArray<PublishItem>,
  ctx: HookContext,
): Promise<ReadonlyArray<PublishItem>> {
  const handlers = registry.getByPhase('beforePublish')
  let current = items
  for (const reg of handlers) {
    current = await runWithTimeout('beforePublish', reg as HookRegistration<'beforePublish'>, async () =>
      (reg.handler as BeforePublishHook)(target, current, ctx),
    )
  }
  return current
}

/** Fan-out `afterPublish` parallel. */
export async function dispatchAfterPublish(
  registry: HookRegistry,
  target: string,
  result: PublishHookResult,
  ctx: HookContext,
): Promise<void> {
  const handlers = registry.getByPhase('afterPublish')
  await runAfterChain(handlers, ctx, async reg => (reg.handler as AfterPublishHook)(target, result, ctx))
}

/** Chain `beforeUpload` handlers. Returns the final asset + bytes. */
export async function dispatchBeforeUpload(
  registry: HookRegistry,
  asset: UploadHookAsset,
  bytes: Uint8Array,
  ctx: HookContext,
): Promise<UploadHookPayload> {
  const handlers = registry.getByPhase('beforeUpload')
  let current: UploadHookPayload = { asset, bytes }
  for (const reg of handlers) {
    current = await runWithTimeout('beforeUpload', reg as HookRegistration<'beforeUpload'>, async () =>
      (reg.handler as BeforeUploadHook)(current.asset, current.bytes, ctx),
    )
  }
  return current
}

/** Fan-out `afterUpload` parallel. */
export async function dispatchAfterUpload(
  registry: HookRegistry,
  asset: UploadHookAsset,
  result: UploadHookResult,
  ctx: HookContext,
): Promise<void> {
  const handlers = registry.getByPhase('afterUpload')
  await runAfterChain(handlers, ctx, async reg => (reg.handler as AfterUploadHook)(asset, result, ctx))
}

/**
 * Run a handler with a per-handler timeout. Wraps non-
 * cancellation errors as `HookCancellation` so call sites can
 * `instanceof HookCancellation` uniformly.
 *
 * Used by `before*` chains. Throws to cancel the operation.
 */
async function runWithTimeout<P extends HookPhase, R>(
  phase: P,
  reg: HookRegistration<P>,
  handler: () => Promise<R>,
): Promise<R> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const handlerPromise = handler()
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new HookTimeout({ hookName: reg.name, phase, timeoutMs: reg.timeout }))
      }, reg.timeout)
      // unref() so a hung handler doesn't keep the process alive.
      // Available on Node setTimeout return; not on browser.
      const t = timer as { unref?: () => void }
      t.unref?.()
    })
    return await Promise.race([handlerPromise, timeoutPromise])
  } catch (err) {
    // HookTimeout and HookCancellation already carry the right
    // shape; rewrap anything else as a HookCancellation so
    // `instanceof HookCancellation` covers both "explicit cancel"
    // and "handler crashed."
    if (err instanceof HookTimeout) throw err
    if (err instanceof HookCancellation) throw err
    throw new HookCancellation({
      hookName: reg.name,
      phase,
      message: err instanceof Error ? err.message : String(err),
      cause: err,
    })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Run an `after*` chain: parallel via `Promise.allSettled`,
 * per-handler timeout, failures logged via ctx.log without
 * propagating.
 */
async function runAfterChain<P extends HookPhase>(
  handlers: ReadonlyArray<HookRegistration<P>>,
  ctx: HookContext,
  invoke: (reg: HookRegistration<P>) => Promise<void>,
): Promise<void> {
  if (handlers.length === 0) return
  const results = await Promise.allSettled(handlers.map(reg => runWithTimeoutAfter(reg, () => invoke(reg))))
  for (const [i, r] of results.entries()) {
    if (r.status === 'rejected') {
      const reg = handlers[i]
      const reason = r.reason
      const isTimeout = reason instanceof HookTimeout
      ctx.log.error(
        {
          hookName: reg.name,
          phase: reg.phase,
          source: reg.source,
          timeout: isTimeout,
          err: reason instanceof Error ? { name: reason.name, message: reason.message } : { message: String(reason) },
        },
        `Hook "${reg.name}" failed in ${reg.phase}`,
      )
    }
  }
}

/**
 * Variant of `runWithTimeout` for `after*` handlers — preserves
 * `HookTimeout` for the logger to discriminate, but doesn't wrap
 * crashes as `HookCancellation` (after-handlers can't cancel).
 */
async function runWithTimeoutAfter<P extends HookPhase>(
  reg: HookRegistration<P>,
  handler: () => Promise<void>,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const handlerPromise = handler()
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new HookTimeout({ hookName: reg.name, phase: reg.phase, timeoutMs: reg.timeout }))
      }, reg.timeout)
      const t = timer as { unref?: () => void }
      t.unref?.()
    })
    await Promise.race([handlerPromise, timeoutPromise])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
