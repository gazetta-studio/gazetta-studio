import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { getType, getEnvironment, isEditable, isHistoryEnabled, getHistoryRetention } from '../../types.js'
import type { StorageProvider, TargetConfig } from '../../types.js'
import { publishItems, resolveDependencies, findFragmentDependents, findDependentsFromSidecars } from '../../publish.js'
import type { SourceContextResolver } from '../source-context.js'
import { mapLimitStream } from '../../concurrency.js'
import type { PublishResult } from '../../publish.js'
import {
  publishPageRendered,
  publishPageStatic,
  publishFragmentRendered,
  publishSiteManifest,
  publishDepIndices,
  createCloudflarePurge,
  lookupCloudflareZoneId,
} from '../../publish-rendered.js'
import { loadSiteFromSource } from '../source-context.js'
import { publishPageAllLocales, publishFragmentAllLocales } from '../../publish-locale.js'
import { resolveEnvVars } from '../../targets.js'
import { isAltAdapterConfigured } from '../../alt/factory.js'
import { resolveAltConfig } from '../../alt/config.js'
import { scanTemplates, templateHashesFrom, type TemplateInfo } from '../../templates-scan.js'
import { hashManifest } from '../../hash.js'
import { createContentRoot } from '../../content-root.js'
import { createHistoryProvider } from '../../history-provider.js'
import { recordWrite, type WrittenItem } from '../../history-recorder.js'
import { publishAssets } from '../../assets/publish.js'
import { requireCapability } from '../middleware/capability.js'
import type { AuditEnv } from '../middleware/audit.js'
import {
  buildHookContext,
  dispatchAfterPublish,
  dispatchBeforePublish,
  HookCancellation,
  HookTimeout,
  type HookRegistry,
  type PublishHookResult,
  type PublishItem,
} from '../../hooks/index.js'
import { makeAuditFiringEmitter } from '../hook-audit-emitter.js'

/**
 * Progress events streamed by runPublish. Consumed both by the SSE route
 * (forwarded to the client as event-stream messages) and the legacy
 * synchronous route (which only takes the final 'done').
 */
export type PublishProgress =
  | { kind: 'start'; targets: string[]; itemsPerTarget: number }
  | { kind: 'target-start'; target: string; total: number }
  | { kind: 'progress'; target: string; current: number; total: number; label: string }
  | { kind: 'target-result'; result: PublishResult }
  | { kind: 'done'; results: PublishResult[] }
  | { kind: 'fatal'; error: string; invalidTemplates?: { name: string; errors: string[] }[] }

export interface PublishRoutesOptions {
  hooks?: HookRegistry
}

export function publishRoutes(
  resolve: SourceContextResolver,
  preInitTargets?: Map<string, StorageProvider>,
  targetConfigs?: Record<string, TargetConfig>,
  templatesDir?: string,
  // Optional injected scanner — the admin-api server memoizes it and
  // clears the cache via its template file watcher. Default: fresh scan
  // on every call (used by the CLI and tests).
  scanTemplatesInjected?: (templatesDir: string, projectRoot: string) => Promise<TemplateInfo[]>,
  opts: PublishRoutesOptions = {},
) {
  const scan = scanTemplatesInjected ?? scanTemplates
  const hooks = opts.hooks
  const app = new Hono<AuditEnv>()

  /**
   * Categorize an item path into the hook payload shape.
   * Items arrive as e.g. `pages/home`, `fragments/header`,
   * `assets/hero`. Hooks see kind + name + path; if the prefix
   * doesn't match, default to 'asset' (covers loose path forms).
   */
  function toPublishItem(itemPath: string): PublishItem {
    if (itemPath.startsWith('pages/')) {
      return { kind: 'page', name: itemPath.slice('pages/'.length), path: itemPath }
    }
    if (itemPath.startsWith('fragments/')) {
      return { kind: 'fragment', name: itemPath.slice('fragments/'.length), path: itemPath }
    }
    return {
      kind: 'asset',
      name: itemPath.startsWith('assets/') ? itemPath.slice('assets/'.length) : itemPath,
      path: itemPath,
    }
  }

  // Background target initialization — lazy, needs the resolved source's
  // projectSiteDir to resolve filesystem target paths. We call resolve()
  // once with undefined (→ default editable) to obtain projectSiteDir.
  let targets: Map<string, StorageProvider> | null = preInitTargets ?? null
  let initPromise: Promise<Map<string, StorageProvider>> | null = null

  async function getTargets(): Promise<Map<string, StorageProvider>> {
    if (targets) return targets
    if (!targetConfigs || Object.keys(targetConfigs).length === 0) {
      targets = new Map()
      return targets
    }
    if (!initPromise) {
      initPromise = (async () => {
        const { createTargetRegistry } = await import('../../targets.js')
        const bootstrapSource = await resolve(undefined)
        const t = await createTargetRegistry(targetConfigs)
        targets = t
        return t
      })().catch(() => {
        targets = new Map()
        return targets
      })
    }
    return initPromise
  }

  function getTargetConfig(name: string): TargetConfig | undefined {
    return targetConfigs?.[name]
  }

  // First-time dependents lookup against a source target needs the
  // `.gazetta/fragment-deps/` index to be present. Save handlers write
  // it incrementally on every save, but a fresh dev server pointed at
  // a content tree that's never been saved through admin will have an
  // empty index. Rebuild once per (source-target) and memoize the
  // in-flight Promise so concurrent tree badges share one walk.
  const fragmentDepsBackfill = new Map<string, Promise<void>>()
  async function ensureFragmentDepsIndex(source: import('../source-context.js').SourceContext): Promise<void> {
    const key = source.targetName ?? '__source__'
    let p = fragmentDepsBackfill.get(key)
    if (p) return p
    p = (async () => {
      const indexRoot = source.contentRoot.path('.gazetta', 'fragment-deps')
      // Cheap existence probe — if any entry is present, the index has
      // been written at least once and incremental save handlers keep
      // it consistent thereafter.
      const exists = await source.storage.exists(indexRoot)
      if (exists) return
      const { rebuildDepIndex } = await import('../../publish-rendered.js')
      const { FRAGMENT_DEPS } = await import('../../fragment-deps.js')
      const site = await loadSiteFromSource(source)
      await rebuildDepIndex(FRAGMENT_DEPS, site, source.storage, source.contentRoot.rootPath)
    })().catch(err => {
      // Clear on failure so the next caller retries.
      fragmentDepsBackfill.delete(key)
      throw err
    })
    fragmentDepsBackfill.set(key, p)
    return p
  }

  app.get('/api/targets', requireCapability('read:pages'), async c => {
    const t = await getTargets()
    // Resolve once — the site manifest is the same across all
    // targets in this loop. resolve(undefined) returns the source
    // context whose .manifest holds `ai:` and `altText:`.
    const source = await resolve(undefined)
    const site = source.manifest
    return c.json(
      [...t.keys()].map(name => {
        const cfg = getTargetConfig(name)
        // AI alt-text capability — site + target inherit chain. When
        // the site manifest isn't available (legacy/test setups), the
        // feature is reported off uniformly.
        const altResolved = site ? resolveAltConfig(site, cfg) : null
        const altAvailable = site ? isAltAdapterConfigured(site, cfg) : false
        return {
          name,
          environment: cfg ? getEnvironment(cfg) : 'local',
          type: cfg ? getType(cfg) : 'static',
          editable: cfg ? isEditable(cfg) : true,
          altText: {
            available: altAvailable,
            // When not configured, the resolved value is null — surface
            // false rather than the hardcoded default so the UI doesn't
            // imply "auto-fire is on" for an unconfigured target.
            auto: altResolved?.auto ?? false,
          },
        }
      }),
    )
  })

  /**
   * Reverse-dependency lookup for publish UI impact preview.
   * GET /api/dependents?item=fragments/header[&target=staging]
   *   → { pages: string[], fragments: string[] }
   *
   * Reads `.gazetta/fragment-deps/` per-edge sidecars on the requested
   * target (or the source when `target` is omitted or names the source).
   * Save handlers maintain the index incrementally; a fresh dev server
   * with no prior saves triggers a one-time rebuild via
   * `ensureFragmentDepsIndex`. Listings only, no content reads —
   * scales to 10k+ items.
   */
  app.get('/api/dependents', requireCapability('read:pages'), async c => {
    const item = c.req.query('item')
    if (!item || !item.startsWith('fragments/')) {
      return c.json({ error: 'Missing or invalid "item" query (must be fragments/<name>)' }, 400)
    }
    const fragmentName = item.slice('fragments/'.length)
    const targetName = c.req.query('target')
    const sourceName = c.req.query('source')
    try {
      const source = await resolve(sourceName)
      const isTargetTheSource = !targetName || targetName === source.targetName
      if (!isTargetTheSource) {
        const t = await getTargets()
        const targetStorage = t.get(targetName!)
        if (!targetStorage) return c.json({ error: `Unknown target: ${targetName}` }, 400)
        const result = await findDependentsFromSidecars(createContentRoot(targetStorage), { fragment: fragmentName })
        return c.json(result)
      }
      await ensureFragmentDepsIndex(source)
      const result = await findDependentsFromSidecars(source.contentRoot, { fragment: fragmentName })
      return c.json(result)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  /**
   * Run a publish, yielding progress events. Both the synchronous
   * /api/publish route and the streaming /api/publish/stream route consume
   * this generator. Caller can short-circuit by returning false from the
   * iterator (or break) and we'll stop between items — but storage operations
   * already in flight will complete.
   *
   * Pre-flight validation (unknown targets, invalid templates) is reported as
   * 'fatal' before any 'target-start' event so callers can map to a 4xx.
   */
  async function* runPublish(
    items: string[],
    targetNames: string[],
    sourceName?: string,
  ): AsyncGenerator<PublishProgress> {
    if (!items?.length) {
      yield { kind: 'fatal', error: 'No items specified' }
      return
    }
    if (!targetNames?.length) {
      yield { kind: 'fatal', error: 'No targets specified' }
      return
    }

    // Resolve the source editable target for this publish run.
    let source: Awaited<ReturnType<SourceContextResolver>>
    try {
      source = await resolve(sourceName)
    } catch (err) {
      yield { kind: 'fatal', error: (err as Error).message }
      return
    }
    const { projectSiteDir } = source

    const t = await getTargets()
    for (const name of targetNames) {
      if (!t.has(name)) {
        yield { kind: 'fatal', error: `Unknown target: ${name}` }
        return
      }
    }

    const allItems = await resolveDependencies(source.contentRoot, items)

    console.log(`  Publishing to ${targetNames.length} target(s):`)
    console.log(`    Items: ${items.join(', ')} (+ ${allItems.length - items.length} dependencies)`)
    console.log(`    Targets: ${targetNames.join(', ')}`)

    const tdir = templatesDir ?? `${projectSiteDir}/templates`
    const projectRoot = projectSiteDir.replace(/\/sites\/[^/]+$/, '')
    const templateInfos = await scan(tdir, projectRoot)
    const invalidTpls = templateInfos.filter(t => !t.valid)
    if (invalidTpls.length) {
      yield {
        kind: 'fatal',
        error: 'Cannot publish: invalid templates',
        invalidTemplates: invalidTpls.map(t => ({ name: t.name, errors: t.errors })),
      }
      return
    }
    const templateHashes = templateHashesFrom(templateInfos)
    const site = await loadSiteFromSource(source, { templatesDir: tdir })

    yield { kind: 'start', targets: targetNames, itemsPerTarget: allItems.length }

    const results: PublishResult[] = []
    for (const targetName of targetNames) {
      const targetStorage = t.get(targetName)!
      const config = getTargetConfig(targetName)
      const isStatic = config ? getType(config) === 'static' : true
      const purgeConfig = config?.cache?.purge

      // Static mode bakes fragments into pages at publish time — if the user
      // picked @header, we must also republish every page that uses it.
      // Expand per-target so ESI targets still get the narrow item set.
      let targetItems = allItems
      if (isStatic) {
        const fragmentItems = items.filter(i => i.startsWith('fragments/'))
        if (fragmentItems.length) {
          const expanded = new Set(allItems)
          for (const frag of fragmentItems) {
            const name = frag.replace('fragments/', '')
            const deps = await findFragmentDependents(source.contentRoot, name)
            for (const p of deps.pages) expanded.add(`pages/${p}`)
          }
          targetItems = [...expanded]
        }
      }

      // Step count: source-copy + per-item render + manifest+index + (purge?)
      const total = 1 + targetItems.length + 1 + (purgeConfig?.type === 'cloudflare' ? 1 : 0)
      yield { kind: 'target-start', target: targetName, total }

      let current = 0
      try {
        let totalFiles = 0
        const targetRoot = createContentRoot(targetStorage)

        // History must record BEFORE the writes so the baseline
        // revision (emitted automatically by recordWrite on the first
        // call against this target) captures pre-publish state.
        // Otherwise "undo this publish" would restore the post-
        // publish state and no-op. See pages.ts save handler.
        if (config && isHistoryEnabled(config)) {
          try {
            const history = createHistoryProvider({
              storage: targetStorage,
              retention: getHistoryRetention(config),
            })
            const items = await collectPublishedItemsForHistory(source.contentRoot, targetRoot, targetItems)
            await recordWrite({
              history,
              contentRoot: targetRoot,
              operation: 'publish',
              source: sourceName,
              items,
            })
          } catch (err) {
            // History is a best-effort audit layer — a write failure
            // here must not break the publish itself.
            console.warn(`    ${targetName}: history record failed — ${(err as Error).message}`)
          }
        }

        // 1. Source copy
        const { copiedFiles } = await publishItems(source.contentRoot, targetRoot, targetItems)
        totalFiles += copiedFiles
        current++
        yield { kind: 'progress', target: targetName, current, total, label: 'source files' }

        // 1b. Asset publish — copy bytes for every `_asset` ref before
        // rendering, so static-mode page HTML never bakes in URLs that
        // resolve to missing bytes on this target. Validation runs first;
        // a structured failure throws and is caught by the per-target
        // try/catch (yielding `target-result success: false`).
        const assetResult = await publishAssets({
          sourceRoot: source.contentRoot,
          targetRoot,
          itemNames: targetItems,
        })
        if (!assetResult.ok) {
          throw new Error(formatAssetPublishFailure(assetResult))
        }
        totalFiles += assetResult.copiedFiles

        // 2. Render items in bounded parallel. Progress events are yielded
        // in completion order — the UI shows X/N + whatever finished last,
        // which stays meaningful without needing input-order. Preserves the
        // event contract: one 'progress' per item between 'target-start'
        // and 'target-result'.
        // Static-mode page hashes must include fragment hashes (a fragment
        // change invalidates every page that bakes it in). Matches the
        // combination used by compareTargets.
        const fragmentHashes = new Map<string, string>()
        if (isStatic) {
          for (const [fragName, frag] of site.fragments) {
            fragmentHashes.set(fragName, hashManifest(frag, { templateHashes }))
          }
        }
        const pageHashOpts = isStatic ? { templateHashes, fragmentHashes } : { templateHashes }

        // SEO context for this target — built once, shared across all page renders.
        const { defaultLocaleFor } = await import('../../locale.js')
        const seo = {
          siteName: site.manifest.name,
          siteUrl: config?.siteUrl,
          locale: defaultLocaleFor(site.manifest),
          defaultOgImage: site.manifest.defaultOgImage,
        }

        const renderItem = async (item: string): Promise<{ files: number }> => {
          if (item.startsWith('pages/')) {
            const raw = item.replace('pages/', '')
            // Support locale-qualified items: pages/home:fr → publish only FR
            const [pageName, itemLocale] = raw.includes(':') ? raw.split(':') : [raw, undefined]
            const page = site.pages.get(pageName)
            const manifestHash = page ? hashManifest(page, pageHashOpts) : undefined
            if (isStatic) {
              return publishPageStatic(
                pageName,
                source.contentRoot,
                targetStorage,
                tdir,
                manifestHash,
                site,
                seo,
                itemLocale,
              )
            }
            // When a specific locale is requested, only publish that one
            const onlyLocales = itemLocale ? [itemLocale] : undefined
            const { files } = await publishPageAllLocales(
              pageName,
              source.contentRoot,
              targetStorage,
              site,
              pageHashOpts,
              { cache: config?.cache, templatesDir: tdir, seo, targetLocales: onlyLocales ?? config?.locales },
            )
            return { files }
          }
          if (item.startsWith('fragments/') && !isStatic) {
            const raw = item.replace('fragments/', '')
            const [fragName, itemLocale] = raw.includes(':') ? raw.split(':') : [raw, undefined]
            const onlyLocales = itemLocale ? [itemLocale] : undefined
            const { files } = await publishFragmentAllLocales(
              fragName,
              source.contentRoot,
              targetStorage,
              site,
              { templateHashes },
              { templatesDir: tdir, targetLocales: onlyLocales ?? config?.locales },
            )
            return { files }
          }
          return { files: 0 } // skipped (e.g. fragment on static target)
        }

        // Render concurrency is lower than listing concurrency — each render
        // may do multiple writes, so 10 in flight is the safe default.
        for await (const { item, result } of mapLimitStream(targetItems, renderItem, 10)) {
          totalFiles += result.files
          current++
          yield { kind: 'progress', target: targetName, current, total, label: item }
        }

        // 3. Site manifest + dep-sidecar indices
        await publishSiteManifest(source.contentRoot, targetStorage, site)
        await publishDepIndices(source.contentRoot, targetStorage, site)
        totalFiles += 1
        current++
        yield { kind: 'progress', target: targetName, current, total, label: 'site manifest' }

        // 3b. Sitemap + robots.txt
        const siteUrl = config?.siteUrl
        if (siteUrl) {
          const { listSidecars } = await import('../../sidecars.js')
          const { generateSitemap } = await import('../../sitemap.js')
          const { generateRobotsTxt } = await import('../../robots.js')
          const targetPageSidecars = await listSidecars(targetStorage, 'pages')
          const sitemapXml = generateSitemap({
            siteUrl,
            pages: targetPageSidecars,
            systemPages: site.manifest.systemPages,
          })
          if (sitemapXml) {
            await targetStorage.writeFile('sitemap.xml', sitemapXml)
            totalFiles++
          }
          // robots.txt only at domain root — Google ignores it at subpaths.
          const isRootDeploy = !new URL(siteUrl).pathname.replace(/\/+$/, '')
          if (isRootDeploy) {
            let robotsTxt: string
            try {
              robotsTxt = await source.contentRoot.storage.readFile(source.contentRoot.path('robots.txt'))
            } catch {
              robotsTxt = generateRobotsTxt({ siteUrl })
            }
            await targetStorage.writeFile('robots.txt', robotsTxt)
            totalFiles++
          }
        }

        // 4. Purge CDN cache
        if (purgeConfig?.type === 'cloudflare') {
          const apiToken = resolveEnvVars(purgeConfig.apiToken)
          const zoneId =
            resolveEnvVars(purgeConfig.zoneId) ??
            (config?.siteUrl && apiToken ? await lookupCloudflareZoneId(config.siteUrl, apiToken) : null)
          if (apiToken && zoneId) {
            const purge = createCloudflarePurge(zoneId, apiToken)
            const hasFragments = targetItems.some(i => i.startsWith('fragments/'))
            if (hasFragments) {
              await purge.purgeAll()
              console.log(`    ${targetName}: cache purged (all)`)
            } else if (config?.siteUrl) {
              const siteForUrls = await loadSiteFromSource(source, { templatesDir })
              const publishedPageNames = new Set(
                targetItems.filter(i => i.startsWith('pages/')).map(i => i.replace('pages/', '')),
              )
              // Collect URLs for all published pages including locale variants
              const urls: string[] = []
              const { allPageEntries } = await import('../../site-loader.js')
              for (const { name, page } of allPageEntries(siteForUrls)) {
                if (publishedPageNames.has(name)) {
                  urls.push(`${config.siteUrl}${page.route}`)
                }
              }
              if (urls.length > 0) {
                await purge.purgeUrls(urls)
                console.log(`    ${targetName}: cache purged (${urls.join(', ')})`)
              }
            }
          }
          current++
          yield { kind: 'progress', target: targetName, current, total, label: 'cache purge' }
        }

        const result: PublishResult = { target: targetName, success: true, copiedFiles: totalFiles }
        results.push(result)
        console.log(`    ${targetName}: ${totalFiles} files`)

        // Publish wrote new manifests to the target's storage. Any
        // SourceContext for that target has a stale cached page /
        // fragment summary. Resolve the target's SourceContext (if
        // the resolver has built one) and invalidate. Cheap; covers
        // the case where the admin UI's active target is the publish
        // destination and the next /api/pages should reflect the
        // newly-published items.
        try {
          const targetSource = await resolve(targetName)
          await Promise.all([
            targetSource.cache.invalidatePrefix('pages:'),
            targetSource.cache.invalidatePrefix('fragments:'),
          ])
        } catch {
          // Resolver may not know this target (registry not configured;
          // legacy single-target setup). Cache invalidation is best-
          // effort; ignore.
        }

        yield { kind: 'target-result', result }
      } catch (err) {
        const error = (err as Error).message
        const result: PublishResult = { target: targetName, success: false, error, copiedFiles: 0 }
        results.push(result)
        console.error(`    ${targetName}: FAILED — ${error}`)
        yield { kind: 'target-result', result }
      }
    }

    yield { kind: 'done', results }
  }

  // Publish routes gate on `publish:non-production` as the baseline.
  // Production-target gating runs inside the handler when iterating
  // requested targets (per design-auth-rbac.md "Failure mode": publish
  // to a production target requires `publish:production`). Cut 9
  // ships the route-level gate; per-target enforcement lands when
  // the route is rewritten to consult the resolved target's
  // environment field.
  app.post('/api/publish', requireCapability('publish:non-production'), async c => {
    const body = (await c.req.json()) as { items: string[]; targets: string[]; source?: string }

    // beforePublish hooks per design-hooks.md "Publish lifecycle".
    // Hooks see the requested items + active target; can mutate
    // the item set (drop / reorder / extend) or throw to cancel
    // the operation. One dispatch per target — operators wanting
    // per-target item filtering branch on `target` inside their
    // handler.
    const hookCtx = hooks
      ? buildHookContext({
          principal: c.var.principal,
          storage: (await resolve(body.source)).storage,
          requestId: c.req.header('x-request-id') ?? crypto.randomUUID(),
          site: { name: undefined },
          auditEmit: makeAuditFiringEmitter(c.var.audit),
        })
      : null
    let finalItems = body.items
    if (hooks && hookCtx) {
      try {
        const inputItems = body.items.map(toPublishItem)
        // Dispatch once per target. Cancellation by any handler
        // aborts the entire publish (multi-target).
        let mutated: ReadonlyArray<PublishItem> = inputItems
        for (const target of body.targets) {
          mutated = await dispatchBeforePublish(hooks, target, mutated, hookCtx)
        }
        finalItems = mutated.map(i => i.path)
      } catch (err) {
        if (err instanceof HookCancellation || err instanceof HookTimeout) {
          await c.var.audit.record({
            action: 'publish',
            outcome: 'forbidden',
            scope: { kind: 'site' },
            metadata: {
              items: body.items,
              targets: body.targets,
              source: body.source,
              hookCancelled: err instanceof HookCancellation ? err.hookName : undefined,
              hookTimeout: err instanceof HookTimeout ? err.hookName : undefined,
            },
          })
          return c.json({ code: 'HOOK_CANCELLED' as const, hook: err.hookName, reason: err.message }, 409)
        }
        throw err
      }
    }

    let results: PublishResult[] = []
    let fatal: PublishProgress | null = null
    for await (const ev of runPublish(finalItems, body.targets, body.source)) {
      if (ev.kind === 'fatal') fatal = ev
      else if (ev.kind === 'done') results = ev.results
    }
    if (fatal) {
      const status = fatal.error.startsWith('Cannot publish') ? 400 : 400
      return c.json(
        { error: fatal.error, ...(fatal.invalidTemplates ? { invalidTemplates: fatal.invalidTemplates } : {}) },
        status,
      )
    }
    const allSuccess = results.every(r => r.success)
    // Audit: one event per publish operation. metadata carries the
    // requested items + targets for forensic queries; per-item
    // events would explode volume on multi-item publishes.
    await c.var.audit.record({
      action: 'publish',
      outcome: 'success',
      scope: { kind: 'site' },
      metadata: { items: finalItems, targets: body.targets, source: body.source },
    })

    // afterPublish hooks per design-hooks.md "Publish lifecycle"
    // step 5. Observational; failures logged. One dispatch per
    // target with that target's per-target result.
    if (hooks && hookCtx) {
      const finalPublishItems = finalItems.map(toPublishItem)
      for (const r of results) {
        const hookResult: PublishHookResult = {
          target: r.target,
          itemsPublished: r.success ? finalPublishItems : [],
          itemsFailed: r.success ? [] : finalPublishItems.map(item => ({ item, reason: r.error ?? 'unknown' })),
        }
        await dispatchAfterPublish(hooks, r.target, hookResult, hookCtx)
      }
    }

    return c.json({ results }, allSuccess ? 200 : 207)
  })

  app.post('/api/publish/stream', requireCapability('publish:non-production'), async c => {
    const body = (await c.req.json()) as { items: string[]; targets: string[]; source?: string }

    // beforePublish hooks fire BEFORE the SSE stream opens — a
    // cancellation surfaces as a 409 (synchronous) rather than as
    // an SSE 'fatal' event, matching the sync /api/publish path.
    const hookCtx = hooks
      ? buildHookContext({
          principal: c.var.principal,
          storage: (await resolve(body.source)).storage,
          requestId: c.req.header('x-request-id') ?? crypto.randomUUID(),
          site: { name: undefined },
          auditEmit: makeAuditFiringEmitter(c.var.audit),
        })
      : null
    let finalItems = body.items
    if (hooks && hookCtx) {
      try {
        let mutated: ReadonlyArray<PublishItem> = body.items.map(toPublishItem)
        for (const target of body.targets) {
          mutated = await dispatchBeforePublish(hooks, target, mutated, hookCtx)
        }
        finalItems = mutated.map(i => i.path)
      } catch (err) {
        if (err instanceof HookCancellation || err instanceof HookTimeout) {
          await c.var.audit.record({
            action: 'publish',
            outcome: 'forbidden',
            scope: { kind: 'site' },
            metadata: {
              items: body.items,
              targets: body.targets,
              source: body.source,
              hookCancelled: err instanceof HookCancellation ? err.hookName : undefined,
              hookTimeout: err instanceof HookTimeout ? err.hookName : undefined,
            },
          })
          return c.json({ code: 'HOOK_CANCELLED' as const, hook: err.hookName, reason: err.message }, 409)
        }
        throw err
      }
    }

    return streamSSE(c, async stream => {
      let recordedSuccess = false
      const collectedResults: PublishResult[] = []
      try {
        for await (const ev of runPublish(finalItems, body.targets, body.source)) {
          if (stream.aborted) return
          await stream.writeSSE({ event: ev.kind, data: JSON.stringify(ev) })
          if (ev.kind === 'done') {
            // Record once per stream — same shape as the
            // synchronous /api/publish endpoint.
            await c.var.audit.record({
              action: 'publish',
              outcome: 'success',
              scope: { kind: 'site' },
              metadata: { items: finalItems, targets: body.targets, source: body.source },
            })
            recordedSuccess = true
            collectedResults.push(...ev.results)
          }
        }
      } catch (err) {
        if (!stream.aborted) {
          await stream.writeSSE({
            event: 'fatal',
            data: JSON.stringify({ kind: 'fatal', error: (err as Error).message }),
          })
        }
      }
      // afterPublish hooks fire after the stream's `done` event —
      // observational; failures logged via ctx.log without
      // affecting the already-streamed response.
      if (hooks && hookCtx && recordedSuccess) {
        const finalPublishItems = finalItems.map(toPublishItem)
        for (const r of collectedResults) {
          const hookResult: PublishHookResult = {
            target: r.target,
            itemsPublished: r.success ? finalPublishItems : [],
            itemsFailed: r.success ? [] : finalPublishItems.map(item => ({ item, reason: r.error ?? 'unknown' })),
          }
          await dispatchAfterPublish(hooks, r.target, hookResult, hookCtx)
        }
      }
      // Avoid recording a duplicate when the loop completed without
      // a 'done' event (rare — happens if runPublish yields fatal
      // before done). Suppresses double-audit; the absence of a
      // success event is itself the forensic signal.
      void recordedSuccess
    })
  })

  app.post('/api/fetch', requireCapability('publish:non-production'), async c => {
    // `source` (body) — target to fetch FROM (a published target)
    // `destination` (body) — optional editable target to write INTO; defaults
    // to the resolver's default editable target (the author's current source)
    const body = (await c.req.json()) as { source: string; items?: string[]; destination?: string }
    if (!body.source) return c.json({ error: 'Missing "source" target name' }, 400)

    const t = await getTargets()
    const targetStorage = t.get(body.source)
    if (!targetStorage) return c.json({ error: `Unknown target: ${body.source}` }, 400)

    // Resolve the destination editable target for this fetch.
    let destination: Awaited<ReturnType<SourceContextResolver>>
    try {
      destination = await resolve(body.destination)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }

    let items: string[]
    if (body.items?.length) {
      items = body.items
    } else {
      items = []
      try {
        if (await targetStorage.exists('pages')) {
          const pages = await targetStorage.readDir('pages')
          for (const p of pages) {
            if (p.isDirectory) items.push(`pages/${p.name}`)
          }
        }
        if (await targetStorage.exists('fragments')) {
          const frags = await targetStorage.readDir('fragments')
          for (const f of frags) {
            if (f.isDirectory) items.push(`fragments/${f.name}`)
          }
        }
        if (await targetStorage.exists('templates')) {
          const tmpls = await targetStorage.readDir('templates')
          for (const t of tmpls) {
            if (t.isDirectory) items.push(`templates/${t.name}`)
          }
        }
      } catch (err) {
        return c.json({ error: `Failed to list target contents: ${(err as Error).message}` }, 500)
      }
    }

    if (items.length === 0) return c.json({ error: 'No content found on target' }, 404)

    console.log(`  Fetching ${items.length} items from "${body.source}":`)
    console.log(`    Items: ${items.join(', ')}`)

    try {
      const targetRoot = createContentRoot(targetStorage)
      const { copiedFiles } = await publishItems(targetRoot, destination.contentRoot, items)
      console.log(`    ${copiedFiles} files copied to working copy`)
      return c.json({ success: true, copiedFiles, items })
    } catch (err) {
      const error = (err as Error).message
      console.error(`    FAILED — ${error}`)
      return c.json({ error }, 500)
    }
  })

  return app
}

/**
 * Build the history `items` for a publish — one entry per published
 * item, content = the source-side manifest. Records semantic authored
 * state (JSON manifests) rather than target-side artifacts (static
 * HTML, fragment indexes), so Restore is a content-level operation.
 *
 * `_targetRoot` is accepted for symmetry with `recordWrite`'s other
 * path-building needs; it's unused today because we hash source
 * content directly and let recordWrite overlay paths relative to the
 * target's rootPath (which is `''` for target-rooted storage, the
 * common case).
 */
async function collectPublishedItemsForHistory(
  sourceRoot: import('../../content-root.js').ContentRoot,
  _targetRoot: import('../../content-root.js').ContentRoot,
  publishedItems: string[],
): Promise<WrittenItem[]> {
  const out: WrittenItem[] = []
  for (const item of publishedItems) {
    const manifestName = item.startsWith('pages/') ? 'page.json' : 'fragment.json'
    const key = `${item}/${manifestName}`
    const sourcePath = sourceRoot.path(key)
    try {
      const content = await sourceRoot.storage.readFile(sourcePath)
      out.push({ path: key, content })
    } catch {
      // Item missing on source (unusual — publish normally reads from
      // source manifests). Skip; snapshot stays as-was for this item.
    }
  }
  return out
}

/**
 * Render an asset-publish failure as a single-line message for the
 * `target-result` error field. Surfaces the structured reason
 * (`missing-on-source`) plus the affected names so the author knows
 * what to fix without digging through logs.
 */
function formatAssetPublishFailure(failure: Exclude<Awaited<ReturnType<typeof publishAssets>>, { ok: true }>): string {
  return `Asset publish failed: source is missing ${failure.missing.length} asset(s) — ${failure.missing.join(', ')}`
}
