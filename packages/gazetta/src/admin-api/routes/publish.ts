import { createRoute, z } from '@hono/zod-openapi'
import { streamSSE } from 'hono/streaming'
import { getType, getEnvironment, isEditable } from '../../types.js'
import type { StorageProvider, TargetConfig } from '../../types.js'
import { stateFolderPath } from '../../state-folders.js'
import { publishItems, resolveDependencies, findFragmentDependents, findDependentsFromSidecars } from '../../publish.js'
import { isValidLocale, normalizeLocale } from '../../locale.js'
import type { SourceContextResolver } from '../source-context.js'
import type { PublishResult } from '../../publish.js'
import { loadSiteFromSource } from '../source-context.js'
import { createPublishSnapshot, type PublishSnapshot } from '../../publish-snapshot.js'
import { isAltAdapterConfigured } from '../../alt/factory.js'
import { resolveAltConfig } from '../../alt/config.js'
import { inspectTarget } from '../../runtime/runtime-capabilities.js'
import { scanTemplates, type TemplateInfo } from '../../templates-scan.js'
import { createContentRoot } from '../../content-root.js'
import { denyWithoutCapability, requireCapability, requireCapabilityOr } from '../middleware/capability.js'
import { problem, problemFrom, type ProblemResponse } from '../problem.js'
import { capabilityGrants, type Principal } from '../../auth/index.js'
import type { Context } from 'hono'
import type { AuditEnv } from '../middleware/audit.js'
import {
  buildHookContext,
  dispatchAfterPublish,
  dispatchBeforePublish,
  dispatchAfterReviewTransition,
  dispatchBeforeReviewTransition,
  HookCancellation,
  HookTimeout,
  type HookRegistry,
  type PublishHookResult,
  type PublishItem,
} from '../../hooks/index.js'
import { makeAuditFiringEmitter } from '../hook-audit-emitter.js'
import { runPublishAudit } from '../../validation/publish-audit.js'
import type { Issue } from '../../validation/types.js'
import { isSafeItemName } from '../../item-name.js'
import { PublishAuditRequestSchema } from '../schemas/validation.js'
import { apiApp, json, problems } from '../openapi.js'
import { publishResultEvent, publishStartEvent, type PublishAuditBase } from '../../publish-audit-events.js'
import type { PublishFailedItem } from '../../publish-target.js'
import { requestItemsOf, requiresPublishApproval } from '../../publish-approval-gate.js'
import type { PublishRequestRecord } from '../../review/publish-requests.js'
import type { AuditContext } from '../../audit/index.js'
import { TargetInfoSchema } from '../schemas/targets.js'
import { DependentsResponseSchema } from '../schemas/dependents.js'
import { FetchResponseSchema } from '../schemas/fetch.js'
import {
  DependentsQuerySchema,
  FetchRequestSchema,
  PublishAuditQuerySchema,
  PublishAuditResultSchema,
  PublishHeadersSchema,
  PublishRequestSchema,
  PublishResponseSchema,
} from '../schemas/publish.js'

const listTargets = createRoute({
  method: 'get',
  path: '/targets',
  summary: 'The configured targets and what each can do',
  middleware: [requireCapability('read:pages')] as const,
  responses: {
    200: json(z.array(TargetInfoSchema), 'The targets'),
    ...problems({ 403: ['FORBIDDEN'] }),
  },
})

const getDependents = createRoute({
  method: 'get',
  path: '/dependents',
  summary: 'The pages and fragments that use a fragment',
  middleware: [requireCapability('read:pages')] as const,
  request: { query: DependentsQuerySchema },
  responses: {
    200: json(DependentsResponseSchema, 'Pages and fragments using the fragment'),
    ...problems({ 400: ['BAD_REQUEST'], 403: ['FORBIDDEN'], 500: ['INTERNAL'] }),
  },
})

/** Errors the two publish routes answer before publishing. */
const publishProblems = problems({
  400: ['BAD_REQUEST', 'TEMPLATE_INVALID'],
  403: ['FORBIDDEN'],
  409: ['HOOK_CANCELLED', 'PUBLISH_AUDIT_FAILED'],
  415: ['BAD_REQUEST'],
  500: ['AUDIT_FAILED', 'INTERNAL'],
})

const publishRequest = {
  headers: PublishHeadersSchema,
  body: { required: true, content: { 'application/json': { schema: PublishRequestSchema } } },
}

const postPublish = createRoute({
  method: 'post',
  path: '/publish',
  summary: 'Publish items to targets',
  // The capability check reads the body's targets: see publishCapabilityGate.
  request: publishRequest,
  responses: {
    200: json(PublishResponseSchema, 'Every target succeeded'),
    207: json(PublishResponseSchema, 'At least one target failed; see each result'),
    ...publishProblems,
  },
})

const postPublishStream = createRoute({
  method: 'post',
  path: '/publish/stream',
  summary: 'Publish items to targets, streaming progress',
  // The capability check reads the body's targets: see publishCapabilityGate.
  request: publishRequest,
  responses: {
    200: {
      description:
        'Server-Sent Events: each event is named after its `kind` and its data is a JSON `PublishProgress` (start, target-start, progress, target-result, done, or fatal)',
      content: { 'text/event-stream': { schema: z.string() } },
    },
    ...publishProblems,
  },
})

const postFetch = createRoute({
  method: 'post',
  path: '/fetch',
  summary: 'Copy content from a target into an editable target',
  middleware: [requireCapability('publish:non-production')] as const,
  request: { body: { required: true, content: { 'application/json': { schema: FetchRequestSchema } } } },
  responses: {
    200: json(FetchResponseSchema, 'The items copied'),
    ...problems({
      400: ['BAD_REQUEST'],
      403: ['FORBIDDEN'],
      404: ['NOT_FOUND'],
      415: ['BAD_REQUEST'],
      500: ['INTERNAL'],
    }),
  },
})

const postPublishAudit = createRoute({
  method: 'post',
  path: '/publish/audit',
  summary: 'Run the pre-publish audit for items about to be published',
  // Read-only, so someone who can only request a publish runs it too (#1787).
  middleware: [requireCapabilityOr('publish:non-production', 'publish:request')] as const,
  request: {
    query: PublishAuditQuerySchema,
    body: { required: true, content: { 'application/json': { schema: PublishAuditRequestSchema } } },
  },
  responses: {
    200: json(PublishAuditResultSchema, 'The issues found'),
    ...problems({ 400: ['BAD_REQUEST'], 403: ['FORBIDDEN'], 415: ['BAD_REQUEST'] }),
  },
})

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
  /**
   * Validator registry — used by `POST /api/publish/audit` to run
   * pre-publish-stage validators against items being published.
   * When omitted, the audit endpoint reports an empty issue list
   * (sites without validation infrastructure pay zero overhead).
   */
  validators?: import('../../validation/registry.js').ValidatorRegistry
  /**
   * Validation cache — passed to render-for-analysis under the audit
   * endpoint. Reuses the scanner's render-for-analysis cache so the
   * audit doesn't re-render pages already seen in the background scan.
   */
  cache?: import('../../cache/types.js').AdminCache
  /**
   * No target with private storage keeps the audit log, so a publish's
   * audit event is dropped and the response says so
   * (design-public-storage.md Q5).
   */
  auditDropped?: boolean
}

/** The line a publish adds when its audit event had nowhere to go. */
export const AUDIT_DROPPED_WARNING = 'Audit event not recorded: no target with private storage keeps the audit log.'

/**
 * One `publish` event per target once its run is over (#1799). Under
 * strict mode each target already has its event from before the write,
 * so only a target that then failed gets a second, `write-failed`, one.
 */
async function recordTargetResults(
  audit: AuditContext,
  results: readonly PublishResult[],
  base: PublishAuditBase,
  strict: boolean,
): Promise<void> {
  for (const r of results) {
    const ev = publishResultEvent(r, base)
    if (strict && ev.outcome === 'success') continue
    await audit.record(ev)
  }
}

/**
 * Strict mode refused the publish because some targets' events failed to
 * record. The targets that were recorded get a `write-failed` event, as
 * nothing reached them.
 */
async function recordRefused(
  audit: AuditContext,
  targets: readonly string[],
  pre: readonly { failed: number }[],
  base: PublishAuditBase,
): Promise<void> {
  for (const [i, t] of targets.entries()) {
    if (pre[i].failed === 0) {
      await audit.record(publishResultEvent({ target: t, success: false, error: 'audit recording failed' }, base))
    }
  }
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
  const auditWarnings = opts.auditDropped ? { warnings: [AUDIT_DROPPED_WARNING] } : {}
  const hooks = opts.hooks
  const app = apiApp<AuditEnv>()

  /**
   * Route-boundary validation for user-supplied item paths (#1196).
   * Accepted forms: `pages/<name>[:<locale>]`, `fragments/<name>[:<locale>]`,
   * `templates/<name>`, `assets/<name>`. Every name segment must be
   * non-empty and not `.`/`..`; no leading `/`, no backslash; a locale
   * suffix must satisfy `isValidLocale`. The raw item used to be joined
   * straight onto a storage root, so `..` segments could read and copy
   * folders outside the site - anything failing these rules is rejected
   * before a path is built from it.
   */
  function parseRouteItem(item: string): { dir: string; knownPrefix: boolean } | null {
    if (item.startsWith('/') || item.includes('\\')) return null
    // Known folder prefixes get locale parsing + an existence check;
    // anything else is an asset-style name (toPublishItem's fallback)
    // and still gets the same segment rules, so no shape can carry a
    // `..` segment through.
    const m = /^(pages|fragments|templates|assets)\/(.+)$/.exec(item)
    const prefix = m ? m[1] : null
    let name = m ? m[2] : item
    if (prefix === 'pages' || prefix === 'fragments') {
      const ci = name.indexOf(':')
      if (ci >= 0) {
        if (!isValidLocale(name.slice(ci + 1))) return null
        name = name.slice(0, ci)
      }
    }
    if (!isSafeItemName(name)) return null
    // Existence is checked for folder items (pages/fragments/templates);
    // asset-style names pass the segment rules only.
    return { dir: prefix ? `${prefix}/${name}` : name, knownPrefix: prefix !== null && prefix !== 'assets' }
  }

  /**
   * Validate request items at the route boundary: shape via
   * parseRouteItem, then existence on the storage they will be read
   * from. Returns the error message for the first bad item, or null.
   */
  async function validateRequestItems(
    items: readonly string[],
    exists: (path: string) => Promise<boolean>,
  ): Promise<string | null> {
    for (const item of items ?? []) {
      const parsed = parseRouteItem(item)
      if (!parsed) return `Invalid item: ${item}`
      if (parsed.knownPrefix && !(await exists(parsed.dir))) return `Unknown item: ${item}`
    }
    return null
  }

  /**
   * Categorize an item path into the hook payload shape.
   * Items arrive as e.g. `pages/home`, `fragments/header`,
   * `assets/hero`. Hooks see kind + name + path; if the prefix
   * doesn't match, default to 'asset' (covers loose path forms).
   */
  /** `pages/home:fr` → `pages/home`: an asset removal keeps back every language of an item. */
  function itemBase(itemPath: string): string {
    const colon = itemPath.indexOf(':')
    return colon === -1 ? itemPath : itemPath.slice(0, colon)
  }

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

  /**
   * Server-side publish gate (Validation Cut 4).
   *
   * Runs `runPublishAudit` for every (target × items) pair the request is
   * asking to publish, applies the per-target `publishAudit.strict`
   * promotion, and returns any error-severity issues. The publish
   * handlers refuse with 409 when this returns non-empty results — the
   * client-side audit modal is the polite UX, this gate is the
   * enforcement layer so a determined client can't bypass.
   *
   * Returns `{ target, issues }` per target that produced errors. Targets
   * with only warns/infos are omitted (errors-only gate).
   */
  /**
   * One snapshot per publish request (design-publish-undo.md Q4, #1632):
   * the gate audits it and the render loop publishes it, so what reaches
   * the target is what was audited.
   */
  async function takeSnapshot(source: import('../source-context.js').SourceContext): Promise<PublishSnapshot> {
    return createPublishSnapshot({
      contentRoot: source.contentRoot,
      manifest: source.manifest,
      templatesDir: templatesDir ?? `${source.projectSiteDir}/templates`,
      cache: source.cache,
    })
  }

  async function evaluatePublishGate(
    source: import('../source-context.js').SourceContext,
    snapshot: PublishSnapshot,
    targetNames: ReadonlyArray<string>,
    itemPaths: ReadonlyArray<string>,
  ): Promise<Array<{ target: string; issues: Issue[] }>> {
    if (!opts.validators) return []
    const items: Array<{ kind: 'page' | 'fragment'; name: string }> = []
    for (const p of itemPaths) {
      const i = toPublishItem(p)
      if (i.kind === 'page' || i.kind === 'fragment') items.push({ kind: i.kind, name: i.name })
    }
    if (items.length === 0) return []
    const { site } = snapshot
    const blocked: Array<{ target: string; issues: Issue[] }> = []
    for (const targetName of targetNames) {
      const targetCfg = source.manifest?.targets?.[targetName]
      const strict = !!targetCfg?.publishAudit?.strict
      const issues = await runPublishAudit({
        items,
        site,
        contentRoot: snapshot.sourceRoot,
        storage: snapshot.sourceRoot.storage,
        registry: opts.validators,
        cache: source.cache,
        strict,
        targetLocales: targetCfg?.locales,
        templatesDir: site.templatesDir,
      })
      const errors = issues.filter(i => i.severity === 'error')
      if (errors.length > 0) blocked.push({ target: targetName, issues: errors })
    }
    return blocked
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
      const indexRoot = source.contentRoot.path(stateFolderPath('fragment-deps'))
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

  app.openapi(listTargets, async c => {
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
        // Runtime capability inspection per
        // `feature-design-process.md`'s capability-gap UX discipline
        // (surface #2 — author-time modal data source). The admin
        // archive modal renders per-target capability badges from
        // these fields; Cut 10 wires the UI.
        const inspection = cfg
          ? inspectTarget(cfg)
          : { has: new Set<string>(), gaps: [] as Array<{ capability: string; reason: string }> }
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
          capabilities: {
            has: [...inspection.has],
            gaps: inspection.gaps.map(g => ({ capability: g.capability, reason: g.reason })),
          },
        }
      }),
      200,
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
  app.openapi(getDependents, async c => {
    const query = c.req.valid('query')
    const item = query.item
    if (!item || !item.startsWith('fragments/')) {
      return problem(c, 400, 'BAD_REQUEST', 'Missing or invalid "item" query (must be fragments/<name>)')
    }
    const fragmentName = item.slice('fragments/'.length)
    const targetName = query.target
    const sourceName = query.source
    try {
      const source = await resolve(sourceName)
      const isTargetTheSource = !targetName || targetName === source.targetName
      if (!isTargetTheSource) {
        const t = await getTargets()
        const targetStorage = t.get(targetName!)
        if (!targetStorage) return problem(c, 400, 'BAD_REQUEST', `Unknown target: ${targetName}`)
        const result = await findDependentsFromSidecars(createContentRoot(targetStorage), { fragment: fragmentName })
        return c.json(result, 200)
      }
      await ensureFragmentDepsIndex(source)
      const result = await findDependentsFromSidecars(source.contentRoot, { fragment: fragmentName })
      return c.json(result, 200)
    } catch (err) {
      return problem(c, 500, 'INTERNAL', (err as Error).message)
    }
  })

  /**
   * The items a publish sends to one target: the requested items and
   * their dependencies, plus, on a static target, every page that uses a
   * requested fragment (static mode bakes fragments into pages, so
   * republishing @header republishes them). ESI targets get the narrow set.
   */
  async function itemsForTarget(
    snapshot: PublishSnapshot,
    items: readonly string[],
    allItems: readonly string[],
    config: TargetConfig | undefined,
  ): Promise<string[]> {
    const isStatic = config ? getType(config) === 'static' : true
    const fragmentItems = items.filter(i => i.startsWith('fragments/'))
    if (!isStatic || fragmentItems.length === 0) return [...allItems]
    const expanded = new Set(allItems)
    for (const frag of fragmentItems) {
      const deps = await findFragmentDependents(snapshot.sourceRoot, frag.replace('fragments/', ''))
      for (const p of deps.pages) expanded.add(`pages/${p}`)
    }
    return [...expanded]
  }

  const isGated = (name: string) => requiresPublishApproval(getTargetConfig(name))

  /**
   * Fire `beforePublishRequest` for every request the gated targets will
   * get (design-review-workflow.md "Hook firings"), before anything is
   * written. A handler that throws cancels the whole publish with 409.
   */
  async function dispatchBeforeRequests(
    c: Context<AuditEnv>,
    hookCtx: ReturnType<typeof buildHookContext> | null,
    snapshot: PublishSnapshot,
    items: string[],
    gatedTargets: readonly string[],
  ): Promise<Response | null> {
    if (!hooks || !hookCtx || gatedTargets.length === 0) return null
    const allItems = await resolveDependencies(snapshot.sourceRoot, items)
    for (const target of gatedTargets) {
      for (const item of requestItemsOf(await itemsForTarget(snapshot, items, allItems, getTargetConfig(target)))) {
        const scope = toPublishItem(itemBase(item))
        try {
          await dispatchBeforeReviewTransition(
            hooks,
            'beforePublishRequest',
            { scope: { kind: scope.kind, name: scope.name }, target },
            hookCtx,
          )
        } catch (err) {
          if (!(err instanceof HookCancellation || err instanceof HookTimeout)) throw err
          await c.var.audit.record({
            action: 'publish-request',
            outcome: 'hook-cancelled',
            scope: { kind: scope.kind, name: scope.name },
            metadata: { targetName: target, item, hook: err.hookName },
          })
          return problem(c, 409, 'HOOK_CANCELLED', err.message, { hook: err.hookName, reason: err.message })
        }
      }
    }
    return null
  }

  /**
   * After a run: one `publish-request` audit event per request a gated
   * target got, and its `afterPublishRequest` hooks. A gated target whose
   * requests couldn't be made records the failure under the same action.
   */
  async function recordRequests(
    audit: AuditContext,
    hookCtx: ReturnType<typeof buildHookContext> | null,
    results: readonly PublishResult[],
    requests: ReadonlyMap<string, readonly PublishRequestRecord[]>,
    items: readonly string[],
  ): Promise<void> {
    for (const r of results) {
      if (!isGated(r.target)) continue
      if (!r.success) {
        await audit.record({
          action: 'publish-request',
          outcome: 'write-failed',
          scope: { kind: 'site', name: r.target },
          metadata: { targetName: r.target, items, error: r.error },
        })
        continue
      }
      for (const req of requests.get(r.target) ?? []) {
        await audit.record({
          action: 'publish-request',
          outcome: 'success',
          scope: { kind: req.kind, name: req.name },
          metadata: { targetName: req.target, requestId: req.id, item: req.item },
        })
        if (hooks && hookCtx) {
          await dispatchAfterReviewTransition(
            hooks,
            'afterPublishRequest',
            { scope: { kind: req.kind, name: req.name }, target: req.target },
            hookCtx,
          )
        }
      }
    }
  }

  /**
   * Run a publish, yielding progress events. Both the synchronous
   * /api/publish route and the streaming /api/publish/stream route consume
   * this generator. Caller can short-circuit by returning false from the
   * iterator (or break) and we'll stop between items — but storage operations
   * already in flight will complete.
   *
   * Pre-flight validation (unknown targets, invalid templates) is reported as
   * 'fatal' before any 'target-start' event so callers can map to a 4xx.
   *
   * A target that requires publish approval gets requests (from
   * `requester`) instead of a publish; they're collected in `requestsOut`.
   */
  async function* runPublish(
    items: string[],
    targetNames: string[],
    sourceName: string | undefined,
    snapshot: PublishSnapshot,
    requester: Principal | undefined,
    requestsOut: Map<string, PublishRequestRecord[]>,
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

    const allItems = await resolveDependencies(snapshot.sourceRoot, items)

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
    // Per Cut 7 cutover: per-item hash composition lives inside publishRun
    // (consumes templateInfos, computes per-item hashManifest including
    // fragmentHashes for static-mode pages). Route doesn't precompute.
    const { site } = snapshot

    yield { kind: 'start', targets: targetNames, itemsPerTarget: allItems.length }

    const results: PublishResult[] = []
    for (const targetName of targetNames) {
      const targetStorage = t.get(targetName)!
      const config = getTargetConfig(targetName)
      const isStatic = config ? getType(config) === 'static' : true
      const purgeConfig = config?.cache?.purge

      const targetItems = await itemsForTarget(snapshot, items, allItems, config)

      // Step count: source-copy + per-item render + manifest+index + (purge?)
      const total = 1 + targetItems.length + 1 + (purgeConfig?.type === 'cloudflare' ? 1 : 0)
      yield { kind: 'target-start', target: targetName, total }

      // Buffer for progress events. The route's outer generator yields
      // SSE frames; the shared publishToTarget call and publishRun's
      // onProgress callback can't yield directly (different generator).
      // Events are pushed into this queue inside callbacks and drained
      // after the call. Order preserved (publishRun runs items
      // sequentially per target); the event VALUES (current/total) are
      // computed in the callbacks exactly as before.
      const progressQueue: PublishProgress[] = []
      // The items publishRun failed on this target, kept for a target
      // that then fails as a whole, so its result keeps their reasons.
      let failedOnTarget: PublishFailedItem[] = []
      try {
        let totalFiles = 0

        // current starts at 1: the source-copy tick is consumed inside
        // the shared function and its 'source files' event is yielded
        // right after the call with this value.
        let current = 1

        // Item-string layout (`pages/home:fr`) split into ItemRefs. Static
        // targets emit only page items (fragments are baked); ESI emits
        // both. Static-mode page hash composition (fragmentHashes) is
        // handled inside publishRun when templateInfos is supplied.
        const itemRefs: { kind: 'page' | 'fragment'; name: string; locale?: string }[] = []
        for (const it of targetItems) {
          if (it.startsWith('pages/')) {
            const raw = it.replace('pages/', '')
            const [name, rawLocale] = raw.includes(':') ? raw.split(':') : [raw, undefined]
            const locale = rawLocale ? normalizeLocale(rawLocale) : undefined
            // Locale-qualified: just the requested variant. Else: default
            // + every supported locale (subject to target.locales filter).
            if (locale) {
              itemRefs.push({ kind: 'page', name, locale })
            } else {
              itemRefs.push({ kind: 'page', name })
              const pageLocales = site.pageLocales.get(name)
              if (pageLocales) {
                for (const loc of pageLocales.locales.keys()) {
                  if (config?.locales && !config.locales.includes(loc)) continue
                  itemRefs.push({ kind: 'page', name, locale: loc })
                }
              }
            }
          } else if (it.startsWith('fragments/') && !isStatic) {
            const raw = it.replace('fragments/', '')
            const [name, rawLocale] = raw.includes(':') ? raw.split(':') : [raw, undefined]
            const locale = rawLocale ? normalizeLocale(rawLocale) : undefined
            if (locale) {
              itemRefs.push({ kind: 'fragment', name, locale })
            } else {
              itemRefs.push({ kind: 'fragment', name })
              const fragLocales = site.fragmentLocales.get(name)
              if (fragLocales) {
                for (const loc of fragLocales.locales.keys()) {
                  if (config?.locales && !config.locales.includes(loc)) continue
                  itemRefs.push({ kind: 'fragment', name, locale: loc })
                }
              }
            }
          }
        }

        // Cutover (publish-undo cut 1, #1426): history record, source
        // manifest copy, render loop, sitemap/robots/redirects, the
        // publish generation and the CDN purge all run inside the
        // shared target-publish function. The route keeps target
        // iteration, the locale fan-out above, 404.html, SSE progress
        // emit and the post-publish cache invalidation. Purge scope is
        // explicit: a fragment publish purges everything, otherwise the
        // published pages' URLs.
        const { publishToTarget } = await import('../../publish-target.js')
        const shared = await publishToTarget({
          targetName,
          targetStorage,
          targetConfig: config,
          snapshot,
          sourceName,
          siteManifest: source.manifest ?? { name: '(publish)' },
          items: targetItems,
          itemRefs,
          templateInfos,
          purgeScope: targetItems.some(i => i.startsWith('fragments/')) ? 'all' : 'items',
          requester,
          onProgress: ev => {
            if (ev.kind === 'item-done') {
              const label =
                (ev.result.kind === 'fragment' ? `@${ev.result.name}` : `pages/${ev.result.name}`) +
                (ev.result.locale ? `:${ev.result.locale}` : '')
              current++
              // SSE consumer reads per-item progress; admin UI updates X/N.
              // Yield is bridged via the outer generator below.
              progressQueue.push({ kind: 'progress', target: targetName, current, total, label })
            }
          },
          onHistoryError: message => {
            // History is a best-effort audit layer - a write failure
            // here must not break the publish itself.
            console.warn(`    ${targetName}: history record failed — ${message}`)
          },
        })

        // A target that requires publish approval got requests; nothing
        // was written to it.
        if (shared.outcome === 'requested') {
          requestsOut.set(targetName, [...shared.requests])
          const result: PublishResult = {
            target: targetName,
            success: true,
            copiedFiles: 0,
            outcome: 'requested',
            requestIds: shared.requests.map(r => r.id),
          }
          results.push(result)
          console.log(`    ${targetName}: ${shared.requests.length} publish request(s) created`)
          yield { kind: 'target-result', result }
          continue
        }

        totalFiles += shared.copiedFiles
        yield { kind: 'progress', target: targetName, current: 1, total, label: 'source files' }

        // publishRun doesn't throw on per-target init failure (assets
        // missing → target failed); surface as the same error the inline
        // path used to throw so the per-target try/catch projects to
        // `target-result success: false`.
        const tr = shared.run
        failedOnTarget = [...shared.failedItems]
        if (tr?.failed) {
          throw new Error(tr.failureReason ?? 'all items failed')
        }
        totalFiles += tr?.filesWritten ?? 0

        // Drain queued progress events from the publishRun callback.
        for (const ev of progressQueue) yield ev
        progressQueue.length = 0

        current++
        yield { kind: 'progress', target: targetName, current, total, label: 'site manifest' }

        // The shared function wrote 404.html for a static target (a
        // generated file, before the generation and the purge, #1430
        // review); generatedFiles carries it, so the count stays.
        totalFiles += shared.generatedFiles.length

        // Purge outcome, in the route's own log format. Missing token
        // or zone stays silent here, as before; a failure is logged,
        // not thrown (#1426).
        if (shared.purge.kind === 'purged-all') {
          console.log(`    ${targetName}: cache purged (all)`)
        } else if (shared.purge.kind === 'purged-urls') {
          console.log(`    ${targetName}: cache purged (${shared.purge.urls.join(', ')})`)
        } else if (shared.purge.kind === 'skipped-no-token') {
          console.log(`    ${targetName}: purge.apiToken not set, skipping cache purge`)
        } else if (shared.purge.kind === 'skipped-no-zone') {
          console.log(`    ${targetName}: zone not found, set purge.zoneId or siteUrl`)
        } else if (shared.purge.kind === 'failed') {
          console.warn(`    ${targetName}: cache purge failed: ${shared.purge.message}`)
        }
        if (purgeConfig?.type === 'cloudflare') {
          current++
          yield { kind: 'progress', target: targetName, current, total, label: 'cache purge' }
        }

        const notPublished = shared.notPublished.map(n => ({
          item: `${n.kind === 'page' ? 'pages' : 'fragments'}/${n.name}`,
          assets: [...n.assets],
          reason: `asset ${n.assets.join(', ')} was removed during the publish; it goes out with the next publish`,
        }))
        for (const n of notPublished) console.warn(`    ${targetName}: ${n.item} not published: ${n.reason}`)
        const result: PublishResult = {
          target: targetName,
          success: true,
          copiedFiles: totalFiles,
          ...(notPublished.length > 0 ? { notPublished } : {}),
          ...(shared.failedItems.length > 0 ? { failedItems: [...shared.failedItems] } : {}),
        }
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
        const result: PublishResult = {
          target: targetName,
          success: false,
          error,
          copiedFiles: 0,
          ...(failedOnTarget.length > 0 ? { failedItems: failedOnTarget } : {}),
        }
        results.push(result)
        console.error(`    ${targetName}: FAILED — ${error}`)
        yield { kind: 'target-result', result }
      }
    }

    yield { kind: 'done', results }
  }

  // Publish routes gate on `publish:non-production` as the baseline.
  // A target whose environment is 'production' additionally requires
  // `publish:production` on the principal (design-auth-rbac.md
  // "Failure mode"). productionGateFailure checks every requested
  // target right after the body is read and BEFORE any hook fires or
  // anything is written: one refused target refuses the whole
  // request, so a mixed staging + production publish never writes
  // the staging half (#1191).
  async function productionGate(c: Context<AuditEnv>, targetNames: ReadonlyArray<string | undefined>) {
    const writesProduction = targetNames.some(name => {
      if (name === undefined) return false
      const config = getTargetConfig(name)
      return config !== undefined && getEnvironment(config) === 'production'
    })
    // The shared check records the #1192 audit event, and lets a token
    // publish to production only with a production elevation (Q17).
    if (!writesProduction) return null
    return (await denyWithoutCapability(c, 'publish:production')) as ProblemResponse<403> | null
  }

  /**
   * The publish routes' capability check (design-review-workflow.md,
   * "Settled by the plan review" items 3 and 13). Destinations that
   * don't require publish approval need `publish:non-production`, and
   * production ones `publish:production` too. A destination that
   * requires approval needs `publish:request` instead, and no publish
   * capability: the gate creates a request there. A request naming no
   * target still gets the baseline check, so anonymous callers get 401.
   *
   * A token publishing to production is checked for `publish:production`
   * before the baseline, so its refusal names the production scope and
   * one production elevation (which also covers non-production, #1729)
   * answers both checks. A token keeps `publish:request` (token-cap.ts),
   * so it reaches the gate on a gated target without an elevation
   * (design-agent-access.md Q20, Q29).
   */
  async function publishCapabilityGate(c: Context<AuditEnv>, targetNames: readonly string[]) {
    const gated = targetNames.filter(name => requiresPublishApproval(getTargetConfig(name)))
    const ungated = targetNames.filter(name => !gated.includes(name))
    const baseline = async () =>
      ungated.length > 0 || gated.length === 0 ? denyWithoutCapability(c, 'publish:non-production') : null
    const token = c.get('principal')?.channel === 'token'
    const first = token ? await productionGate(c, ungated) : await baseline()
    if (first) return first
    const second = token ? await baseline() : await productionGate(c, ungated)
    if (second) return second
    if (gated.length === 0) return null
    return denyWithoutCapability(
      c,
      'publish:request',
      `${gated.join(', ')} ${gated.length === 1 ? 'requires' : 'require'} publish approval, and role "${c.get('principal')?.role}" can't request it. Ask an admin for the "publish:request" capability.`,
    )
  }

  // Only refusals end the request here; the body read is cached for the
  // route's validator.
  for (const path of ['/publish', '/publish/stream']) {
    app.use(path, async (c, next) => {
      if (c.req.method !== 'POST') return next()
      const body = (await c.req.json().catch(() => null)) as { targets?: unknown } | null
      const targets = Array.isArray(body?.targets) ? body.targets.filter((t): t is string => typeof t === 'string') : []
      const denied = await publishCapabilityGate(c as unknown as Context<AuditEnv>, targets)
      return denied ?? next()
    })
  }

  app.openapi(postPublish, async c => {
    const body = c.req.valid('json')
    // Targets that require publish approval get requests, not a publish:
    // no publish hooks, audit events or strict pre-record for them.
    const ungatedTargets = body.targets.filter(t => !isGated(t))
    const gatedTargets = body.targets.filter(isGated)

    // #1196: reject malformed or unknown items before anything reads
    // or writes a path built from them.
    const sourceForValidation = await resolve(body.source)
    const itemError = await validateRequestItems(body.items, p =>
      sourceForValidation.storage.exists(sourceForValidation.contentRoot.path(p)),
    )
    if (itemError) return problem(c, 400, 'BAD_REQUEST', itemError)

    // #1526: publishing into the editing source copies the site onto
    // itself. Refuse before hooks, the gate or any write.
    const intoSource = body.targets?.find(t => t === sourceForValidation.targetName)
    if (intoSource) return problem(c, 400, 'BAD_REQUEST', `Cannot publish to ${intoSource}: it is the editing source`)

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
          requestId: c.req.valid('header')['x-request-id'] ?? crypto.randomUUID(),
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
        for (const target of ungatedTargets) {
          mutated = await dispatchBeforePublish(hooks, target, mutated, hookCtx)
        }
        finalItems = mutated.map(i => i.path)
      } catch (err) {
        if (err instanceof HookCancellation || err instanceof HookTimeout) {
          // Per design-hooks.md Q3 audit lock: cancelled publishes
          // record outcome 'hook-cancelled' (not 'forbidden' — hook
          // policy is operator decision, not a capability denial).
          await c.var.audit.record({
            action: 'publish',
            outcome: 'hook-cancelled',
            scope: { kind: 'site' },
            metadata: {
              items: body.items,
              targets: body.targets,
              source: body.source,
              hookCancelled: err instanceof HookCancellation ? err.hookName : undefined,
              hookTimeout: err instanceof HookTimeout ? err.hookName : undefined,
            },
          })
          return problem(c, 409, 'HOOK_CANCELLED', err.message, { hook: err.hookName, reason: err.message })
        }
        throw err
      }
    }

    // Server-side publish gate per design-validation.md Cut 4. Runs the
    // same `runPublishAudit` the client-side modal calls; refuses on
    // remaining error-severity issues so a determined client can't
    // bypass the dialog. `publishAudit.strict` is applied per-target.
    const sourceForGate = await resolve(body.source)
    const snapshot = await takeSnapshot(sourceForGate)
    const blocked = await evaluatePublishGate(sourceForGate, snapshot, body.targets, finalItems)
    if (blocked.length > 0) {
      await c.var.audit.record({
        action: 'publish',
        outcome: 'validation-failed',
        scope: { kind: 'site' },
        metadata: {
          items: finalItems,
          targets: body.targets,
          source: body.source,
          blockedTargets: blocked.map(b => b.target),
        },
      })
      return problem(c, 409, 'PUBLISH_AUDIT_FAILED', undefined, { blocked })
    }

    const requestCancelled = await dispatchBeforeRequests(c, hookCtx, snapshot, finalItems, gatedTargets)
    if (requestCancelled) return requestCancelled as ProblemResponse<409>

    // Strict audit mode (#1393, design-audit.md "Strict mode
    // opt-in"): record the publish event BEFORE any target write;
    // a failed recording refuses the publish before anything
    // changes. The post-publish success record below is skipped
    // when this ran.
    const strictPreRecord = c.var.audit?.strict === true
    if (strictPreRecord) {
      // One event per target, each before anything is written (#1799).
      const pre = await Promise.all(
        ungatedTargets.map(t => c.var.audit.record(publishStartEvent(t, { items: finalItems, source: body.source }))),
      )
      if (pre.some(r => r.failed > 0)) {
        // Targets whose event was recorded get their compensating event:
        // nothing was written to them.
        await recordRefused(c.var.audit, ungatedTargets, pre, { items: finalItems, source: body.source })
        return problem(c, 500, 'AUDIT_FAILED', 'Audit recording failed; publish refused (strict mode)')
      }
    }

    let results: PublishResult[] = []
    let fatal: PublishProgress | null = null
    const requests = new Map<string, PublishRequestRecord[]>()
    for await (const ev of runPublish(finalItems, body.targets, body.source, snapshot, c.var.principal, requests)) {
      if (ev.kind === 'fatal') fatal = ev
      else if (ev.kind === 'done') results = ev.results
    }
    const auditBase = { items: finalItems, source: body.source }
    if (fatal) {
      // Under strict mode each target's pre-write event already claims
      // the publish; a second event per target records the failure so
      // the log stays honest (#1393).
      if (strictPreRecord) {
        const error = fatal.kind === 'fatal' ? fatal.error : undefined
        for (const t of ungatedTargets) {
          await c.var.audit.record(publishResultEvent({ target: t, success: false, error }, auditBase))
        }
      }
      return fatal.invalidTemplates
        ? problem(c, 400, 'TEMPLATE_INVALID', fatal.error, { invalidTemplates: fatal.invalidTemplates })
        : problem(c, 400, 'BAD_REQUEST', fatal.error)
    }
    const allSuccess = results.every(r => r.success)
    const published = results.filter(r => !isGated(r.target))
    await recordTargetResults(c.var.audit, published, auditBase, strictPreRecord)
    await recordRequests(c.var.audit, hookCtx, results, requests, finalItems)

    // afterPublish hooks per design-hooks.md "Publish lifecycle"
    // step 5. Observational; failures logged. One dispatch per
    // target with that target's per-target result.
    if (hooks && hookCtx) {
      const finalPublishItems = finalItems.map(toPublishItem)
      for (const r of published) {
        const skipped = new Map((r.notPublished ?? []).map(n => [n.item, n.reason]))
        const hookResult: PublishHookResult = {
          target: r.target,
          itemsPublished: r.success ? finalPublishItems.filter(item => !skipped.has(itemBase(item.path))) : [],
          itemsFailed: r.success
            ? finalPublishItems.flatMap(item =>
                skipped.has(itemBase(item.path)) ? [{ item, reason: skipped.get(itemBase(item.path))! }] : [],
              )
            : finalPublishItems.map(item => ({ item, reason: r.error ?? 'unknown' })),
        }
        await dispatchAfterPublish(hooks, r.target, hookResult, hookCtx)
      }
    }

    return c.json({ results, ...auditWarnings }, allSuccess ? 200 : 207)
  })

  app.openapi(postPublishStream, async c => {
    const body = c.req.valid('json')
    // As in /api/publish: gated targets get requests, not a publish.
    const ungatedTargets = body.targets.filter(t => !isGated(t))
    const gatedTargets = body.targets.filter(isGated)

    // #1196: reject malformed or unknown items before anything reads
    // or writes a path built from them (synchronous 400, before the
    // SSE stream opens - same surface as the sync route).
    const sourceForValidation = await resolve(body.source)
    const itemError = await validateRequestItems(body.items, p =>
      sourceForValidation.storage.exists(sourceForValidation.contentRoot.path(p)),
    )
    if (itemError) return problem(c, 400, 'BAD_REQUEST', itemError)

    // #1526: publishing into the editing source copies the site onto
    // itself. Refuse before hooks, the gate or any write.
    const intoSource = body.targets?.find(t => t === sourceForValidation.targetName)
    if (intoSource) return problem(c, 400, 'BAD_REQUEST', `Cannot publish to ${intoSource}: it is the editing source`)

    // beforePublish hooks fire BEFORE the SSE stream opens — a
    // cancellation surfaces as a 409 (synchronous) rather than as
    // an SSE 'fatal' event, matching the sync /api/publish path.
    const hookCtx = hooks
      ? buildHookContext({
          principal: c.var.principal,
          storage: (await resolve(body.source)).storage,
          requestId: c.req.valid('header')['x-request-id'] ?? crypto.randomUUID(),
          site: { name: undefined },
          auditEmit: makeAuditFiringEmitter(c.var.audit),
        })
      : null
    let finalItems = body.items
    if (hooks && hookCtx) {
      try {
        let mutated: ReadonlyArray<PublishItem> = body.items.map(toPublishItem)
        for (const target of ungatedTargets) {
          mutated = await dispatchBeforePublish(hooks, target, mutated, hookCtx)
        }
        finalItems = mutated.map(i => i.path)
      } catch (err) {
        if (err instanceof HookCancellation || err instanceof HookTimeout) {
          // Per design-hooks.md Q3 audit lock: cancelled publishes
          // record outcome 'hook-cancelled' (not 'forbidden' — hook
          // policy is operator decision, not a capability denial).
          await c.var.audit.record({
            action: 'publish',
            outcome: 'hook-cancelled',
            scope: { kind: 'site' },
            metadata: {
              items: body.items,
              targets: body.targets,
              source: body.source,
              hookCancelled: err instanceof HookCancellation ? err.hookName : undefined,
              hookTimeout: err instanceof HookTimeout ? err.hookName : undefined,
            },
          })
          return problem(c, 409, 'HOOK_CANCELLED', err.message, { hook: err.hookName, reason: err.message })
        }
        throw err
      }
    }

    // Server-side publish gate (mirrors /api/publish). Surfaces as a
    // synchronous 409 before the SSE stream opens, so the client can
    // treat audit-failure identically across the two endpoints.
    const sourceForGate = await resolve(body.source)
    const snapshot = await takeSnapshot(sourceForGate)
    const blocked = await evaluatePublishGate(sourceForGate, snapshot, body.targets, finalItems)
    if (blocked.length > 0) {
      await c.var.audit.record({
        action: 'publish',
        outcome: 'validation-failed',
        scope: { kind: 'site' },
        metadata: {
          items: finalItems,
          targets: body.targets,
          source: body.source,
          blockedTargets: blocked.map(b => b.target),
        },
      })
      return problem(c, 409, 'PUBLISH_AUDIT_FAILED', undefined, { blocked })
    }

    const requestCancelled = await dispatchBeforeRequests(c, hookCtx, snapshot, finalItems, gatedTargets)
    if (requestCancelled) return requestCancelled as ProblemResponse<409>

    // Strict audit mode (#1393): same pre-record as the sync route,
    // placed synchronously BEFORE the SSE stream opens so a failed
    // recording refuses the publish with AUDIT_FAILED and nothing
    // reaches the target. The admin's Publish button calls this
    // endpoint, so without it a strict site would still publish
    // from the admin UI.
    const strictPreRecord = c.var.audit?.strict === true
    if (strictPreRecord) {
      // One event per target, each before anything is written (#1799).
      const pre = await Promise.all(
        ungatedTargets.map(t => c.var.audit.record(publishStartEvent(t, { items: finalItems, source: body.source }))),
      )
      if (pre.some(r => r.failed > 0)) {
        // Targets whose event was recorded get their compensating event:
        // nothing was written to them.
        await recordRefused(c.var.audit, ungatedTargets, pre, { items: finalItems, source: body.source })
        return problem(c, 500, 'AUDIT_FAILED', 'Audit recording failed; publish refused (strict mode)')
      }
    }

    return streamSSE(c, async stream => {
      let recordedSuccess = false
      let recordedWriteFailed = false
      const collectedResults: PublishResult[] = []
      // Under strict mode the pre-write record already claims the
      // publish; a fatal (yielded or thrown) gets one compensating
      // 'write-failed' event (#1393).
      const auditBase = { items: finalItems, source: body.source }
      // Targets whose result already streamed keep it; a thrown error
      // fails only the ones still to come.
      const finishedTargets = new Set<string>()
      const recordWriteFailed = async (error?: string): Promise<void> => {
        if (!strictPreRecord || recordedWriteFailed) return
        recordedWriteFailed = true
        for (const t of ungatedTargets) {
          if (finishedTargets.has(t)) continue
          await c.var.audit.record(publishResultEvent({ target: t, success: false, error }, auditBase))
        }
      }
      const requests = new Map<string, PublishRequestRecord[]>()
      // Gated targets whose requests are recorded (audit + after hooks).
      // Recorded per target as its result arrives, so requests written to
      // the source are never left without their events.
      const recordedRequests = new Set<string>()
      const recordRequestsOf = async (results: readonly PublishResult[]) => {
        const fresh = results.filter(r => isGated(r.target) && !recordedRequests.has(r.target))
        for (const r of fresh) recordedRequests.add(r.target)
        await recordRequests(c.var.audit, hookCtx, fresh, requests, finalItems)
      }
      // The publish runs to completion whether or not the client stays
      // connected (#1068): it never awaits the stream, so a slow or gone
      // client can't stall or stop it. Events queue here and a forwarder
      // writes them while the stream is open.
      const queued: { event: string; data: string }[] = []
      let wake: (() => void) | null = null
      let finished = false
      const notify = (): void => wake?.()
      const emit = (event: string, data: unknown): void => {
        if (stream.aborted) return
        queued.push({ event, data: JSON.stringify(data) })
        notify()
      }
      stream.onAbort(notify)
      const forward = (async () => {
        while (!stream.aborted) {
          const next = queued.shift()
          if (next) {
            await stream.writeSSE(next)
            continue
          }
          if (finished) return
          await new Promise<void>(resolve => {
            wake = resolve
          })
          wake = null
        }
      })()
      const work = async (): Promise<void> => {
        try {
          for await (const ev of runPublish(
            finalItems,
            body.targets,
            body.source,
            snapshot,
            c.var.principal,
            requests,
          )) {
            const data = ev.kind === 'done' ? { ...ev, ...auditWarnings } : ev
            emit(ev.kind, data)
            if (ev.kind === 'fatal') {
              await recordWriteFailed(ev.error)
            }
            if (ev.kind === 'target-result') {
              finishedTargets.add(ev.result.target)
              await recordRequestsOf([ev.result])
              // Under strict mode a failed target's write-failed event is
              // recorded now, so a later thrown error doesn't record it twice.
              if (strictPreRecord && !isGated(ev.result.target)) {
                await recordTargetResults(c.var.audit, [ev.result], auditBase, true)
              }
            }
            if (ev.kind === 'done') {
              // One event per target, as the synchronous /api/publish records.
              // Strict mode recorded each target's failure at its target-result.
              const published = ev.results.filter(r => !isGated(r.target))
              if (!strictPreRecord) await recordTargetResults(c.var.audit, published, auditBase, false)
              await recordRequestsOf(ev.results)
              recordedSuccess = true
              collectedResults.push(...ev.results)
            }
          }
        } catch (err) {
          await recordWriteFailed((err as Error).message)
          emit('fatal', { kind: 'fatal', error: (err as Error).message })
        }
        // afterPublish hooks fire after the stream's `done` event —
        // observational; failures logged via ctx.log without
        // affecting the already-streamed response.
        if (hooks && hookCtx && recordedSuccess) {
          const finalPublishItems = finalItems.map(toPublishItem)
          for (const r of collectedResults.filter(res => !isGated(res.target))) {
            const skipped = new Map((r.notPublished ?? []).map(n => [n.item, n.reason]))
            const hookResult: PublishHookResult = {
              target: r.target,
              itemsPublished: r.success ? finalPublishItems.filter(item => !skipped.has(itemBase(item.path))) : [],
              itemsFailed: r.success
                ? finalPublishItems.flatMap(item =>
                    skipped.has(itemBase(item.path)) ? [{ item, reason: skipped.get(itemBase(item.path))! }] : [],
                  )
                : finalPublishItems.map(item => ({ item, reason: r.error ?? 'unknown' })),
            }
            await dispatchAfterPublish(hooks, r.target, hookResult, hookCtx)
          }
        }
      }
      try {
        await work()
      } finally {
        finished = true
        notify()
      }
      await forward

      // Avoid recording a duplicate when the loop completed without
      // a 'done' event (rare — happens if runPublish yields fatal
      // before done). Suppresses double-audit; the absence of a
      // success event is itself the forensic signal.
      void recordedSuccess
    })
  })

  app.openapi(postFetch, async c => {
    // `source` (body) — target to fetch FROM (a published target)
    // `destination` (body) — optional editable target to write INTO; defaults
    // to the resolver's default editable target (the author's current source)
    const body = c.req.valid('json')
    if (!body.source) return problem(c, 400, 'BAD_REQUEST', 'Missing "source" target name')

    const t = await getTargets()
    const targetStorage = t.get(body.source)
    if (!targetStorage) return problem(c, 400, 'BAD_REQUEST', `Unknown target: ${body.source}`)

    // Resolve the destination editable target for this fetch.
    let destination: Awaited<ReturnType<SourceContextResolver>>
    try {
      destination = await resolve(body.destination)
    } catch (err) {
      return problem(c, 400, 'BAD_REQUEST', (err as Error).message)
    }

    // #1191: gate the RESOLVED destination. An omitted destination
    // resolves to the registry's default editable target, which can be
    // an editable production target; resolve() only reads, so nothing
    // is written before this check.
    const fetchProductionForbidden = await productionGate(c, [destination.targetName ?? body.destination])
    if (fetchProductionForbidden) return fetchProductionForbidden

    // A fetch writes into its destination directly, without the shared
    // target-publish function, so it can't go through the publish-approval
    // gate. Into a target that requires approval it's refused before any
    // write until a fetch can be a publish request (#1787).
    const fetchInto = destination.targetName ?? body.destination
    if (fetchInto && isGated(fetchInto)) {
      return problem(
        c,
        400,
        'BAD_REQUEST',
        `${fetchInto} requires publish approval, so fetching into it isn't supported yet. Publish into it from another target instead, which creates a publish request.`,
      )
    }

    let items: string[]
    if (body.items?.length) {
      // #1196: same boundary validation against the fetch source.
      const itemError = await validateRequestItems(body.items, p => targetStorage.exists(p))
      if (itemError) return problem(c, 400, 'BAD_REQUEST', itemError)
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
        return problem(c, 500, 'INTERNAL', `Failed to list target contents: ${(err as Error).message}`)
      }
    }

    if (items.length === 0) return problem(c, 404, 'NOT_FOUND', 'No content found on target')

    console.log(`  Fetching ${items.length} items from "${body.source}":`)
    console.log(`    Items: ${items.join(', ')}`)

    try {
      const targetRoot = createContentRoot(targetStorage)
      const { copiedFiles } = await publishItems(targetRoot, destination.contentRoot, items, {
        includeNestedItems: true,
      })
      console.log(`    ${copiedFiles} files copied to working copy`)
      return c.json({ success: true, copiedFiles, items }, 200)
    } catch (err) {
      const error = (err as Error).message
      console.error(`    FAILED — ${error}`)
      return problem(c, 500, 'INTERNAL', error)
    }
  })

  /**
   * POST /api/publish/audit — runs pre-publish-stage validators against the
   * items operator is about to publish. Returns the consolidated `Issue[]`,
   * with `publishAudit.strict` promotion already applied (warns → errors)
   * for the destination target.
   *
   * The audit is read-only: it doesn't write to storage, doesn't fire hooks,
   * doesn't trigger publish. It's the pre-flight check the publish dialog
   * surfaces before the user clicks "Publish."
   *
   * Server-side enforcement of the audit happens at `POST /api/publish` —
   * this endpoint is the read surface; the gate is the publish handler
   * itself. Defense in depth: client-side dialog uses this endpoint for
   * display; server-side publish re-runs the same audit and refuses on
   * errors, so a determined client can't bypass.
   */
  app.openapi(
    postPublishAudit,
    async c => {
      const { target: targetName, items } = c.req.valid('json')

      const source = await resolve(c.req.valid('query').target)
      const site = await loadSiteFromSource(source, {
        templatesDir: templatesDir ?? `${source.projectSiteDir}/templates`,
      })
      const targetCfg = source.manifest?.targets?.[targetName]
      const strict = !!targetCfg?.publishAudit?.strict

      if (!opts.validators) {
        // No validator registry wired; return empty issues.
        return c.json({ issues: [], strict }, 200)
      }

      const issues = await runPublishAudit({
        items,
        site,
        contentRoot: source.contentRoot,
        storage: source.storage,
        registry: opts.validators,
        cache: source.cache,
        strict,
        targetLocales: targetCfg?.locales,
        templatesDir: site.templatesDir,
      })

      // Capability-gap UX surface #4 (pre-publish gate) per
      // `feature-design-process.md`'s capability-gap-UX discipline.
      // When the publish set includes any archived items, surface the
      // destination target's capability info so the publish dialog can
      // warn operators (e.g., "this target won't emit 301 redirects").
      const includesArchived = items.some(i => {
        const m = i.kind === 'page' ? site.pages.get(i.name) : site.fragments.get(i.name)
        return m?.archived === true
      })
      let capabilities: { has: string[]; gaps: Array<{ capability: string; reason: string }> } | undefined
      if (includesArchived && targetCfg) {
        const inspection = inspectTarget(targetCfg)
        capabilities = {
          has: [...inspection.has],
          gaps: inspection.gaps.map(g => ({ capability: g.capability, reason: g.reason })),
        }
      }
      return c.json({ issues, strict, ...(capabilities ? { capabilities } : {}) }, 200)
    },
    // The audit's own message for a body that isn't { target, items }.
    (result, c) => {
      if (!result.success) return problem(c, 400, 'BAD_REQUEST', 'expected { target: string, items: SavedItem[] }')
    },
  )

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
