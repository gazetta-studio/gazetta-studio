/**
 * Rename routes for pages + fragments.
 *
 * Per `design-soft-delete.md` Q3 (G1: flatten on rename) and Cut 6 of
 * the implementation plan: rename is a composite operation —
 *
 *   1. create-new: write the new manifest at `to` with copied content
 *   2. archive-old: archive the old name with `aliasOf: to`
 *   3. flatten cascade: walk archives where `aliasOf === fromName` and
 *      rewrite each to `aliasOf: to` (Q3 G1 invariant: aliases never chain)
 *
 * Single composite `action: 'rename'` audit event (Q8 M4 lock); the
 * component archive + create-new + flatten cascade do NOT emit their
 * own events.
 *
 * # Order matters for failure-mode safety (Q2 B1)
 *
 * Create-new first → archive-old second → flatten third. Why:
 *   - Step 1 fail: nothing changed; clean 500.
 *   - Step 2 fail: B exists live, A live; partial state surfaced as
 *     500 RENAME_PARTIAL; retry is idempotent.
 *   - Step 3 fail: A is archived → B; some archives still point at A
 *     (chain). Validator P3 surfaces the chain on next save; retry
 *     of the rename re-runs flatten (idempotent).
 *
 * # Conflict shape (Q3 C1)
 *
 *   - Live `to` exists → 409 NAME_COLLISION (caller picks different name)
 *   - Archived `to` exists → 409 ARCHIVED_NAME_CONFLICT (caller resolves
 *     via Cut 11's three-option prompt: Restore / Replace / Move aside)
 *
 * # Locale variants (Q5 E1)
 *
 * Whole-directory rename: `pages/old/{page.json, page.fr.json, page.es.json}`
 * → `pages/new/`. Locale variants share parent's archive state. Audit
 * `metadata.localeVariants: [...]` records which locales were affected.
 *
 * # Capability (Q6 F1)
 *
 * `edit:{kind}` — rename is content-state edit. Symmetric with unarchive.
 *
 * # Publish behavior (Q7 G1)
 *
 * Zero new publish-time logic. Archive's HTML comment marker (Cut 3)
 * handles the 301 redirect for worker-served targets; `_redirects`
 * (Cut 4) handles plain-static. Rename is just "create-new + archive
 * with aliasOf"; the published-state behavior is whatever archive
 * already delivers.
 *
 * # SOLID lenses
 *
 *   - SRP: this module owns rename's three-step composition. Doesn't
 *     reuse archive routes' HTTP handlers (they audit independently);
 *     does reuse the `archive-aliases` sidecar primitives.
 *   - DIP: depends on `rebuildArchiveAliases` + `findArchivesAliasingInSite`
 *     primitives, not their per-edge sidecar implementation details.
 */
import { createRoute } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { join } from 'node:path'
import type { SourceContextResolver } from '../source-context.js'
import type { Site } from '../../site-loader.js'
import { findArchivesAliasingInSite, findFragmentUsersInSite } from '../../site-users.js'
import { loadSiteFromSource } from '../source-context.js'
import type { SourceContext } from '../source-context.js'
import { recordWrite } from '../../history-recorder.js'
import { denyWithoutCapability, requireCapability } from '../middleware/capability.js'
import { requireEditableTarget } from '../middleware/editable-target.js'
import { lookupManifest } from '../lookup-manifest.js'
import { problem, problemFrom, type ProblemResponse } from '../problem.js'
import { apiApp, json, problems } from '../openapi.js'
import { bodyFailure, jsonBody } from '../route-input.js'
import { ForceQuerySchema, ItemNameParamSchema } from '../schemas/item-route.js'
import type { AuditEnv } from '../middleware/audit.js'
import type { ItemRef } from '../../dep-sidecars.js'
import { rebuildArchiveAliases } from '../../archive-aliases.js'
import { rebuildAssetRefs } from '../../assets/asset-deps.js'
import { rebuildFragmentDeps } from '../../fragment-deps.js'
import {
  RenameRequestSchema,
  RenameResponseSchema,
  type ArchivedNameConflict,
  type NameCollision,
  type RenameResponse,
} from '../schemas/rename.js'
import type { ComponentManifest, FragmentManifest, PageManifest } from '../../types.js'

type ItemKind = 'page' | 'fragment'

interface ItemHandle {
  refSource: ItemRef['source']
  scopeKind: ItemKind
  filename: string
  label: string
}

const PAGE_HANDLE: ItemHandle = {
  refSource: 'page',
  scopeKind: 'page',
  filename: 'page.json',
  label: 'Page',
}

const FRAGMENT_HANDLE: ItemHandle = {
  refSource: 'fragment',
  scopeKind: 'fragment',
  filename: 'fragment.json',
  label: 'Fragment',
}

export function renameRoutes(resolve: SourceContextResolver) {
  const editableTarget = requireEditableTarget(resolve)
  const app = apiApp<AuditEnv>()

  const mount = <K extends 'pages' | 'fragments'>(kind: K, handle: ItemHandle) => {
    const rename = createRoute({
      method: 'post',
      path: `/api/${kind}/:name/rename`,
      summary: `Rename a ${handle.label.toLowerCase()}`,
      middleware: [
        requireCapability(`edit:${kind}`),
        editableTarget,
        jsonBody({ malformed: { code: 'BAD_REQUEST', detail: 'Invalid JSON body' } }),
      ] as const,
      request: {
        params: ItemNameParamSchema,
        query: ForceQuerySchema,
        body: { required: true, content: { 'application/json': { schema: RenameRequestSchema } } },
      },
      responses: {
        200: json(RenameResponseSchema, 'Renamed (or the name is unchanged)'),
        ...problems({
          400: ['BAD_REQUEST'],
          401: ['UNAUTHENTICATED'],
          403: ['FORBIDDEN', 'TARGET_NOT_EDITABLE'],
          404: ['NOT_FOUND'],
          409: ['ARCHIVED_NAME_CONFLICT', 'NAME_COLLISION', 'ARCHIVE_HAS_LIVE_REFS'],
          415: ['BAD_REQUEST'],
          500: ['RENAME_PARTIAL'],
        }),
      },
    })
    app.openapi(
      rename,
      c => {
        const { name } = c.req.valid('param')
        const { target, force } = c.req.valid('query')
        const { to, keepAlias } = c.req.valid('json')
        return handleRename(c, resolve, handle, { fromName: name, target, force: force === 'true', to, keepAlias })
      },
      bodyFailure('BAD_REQUEST', 'Invalid request body'),
    )
  }

  mount('pages', PAGE_HANDLE)
  mount('fragments', FRAGMENT_HANDLE)

  return app
}

interface RenameInput {
  fromName: string
  target?: string
  force: boolean
  to: string
  keepAlias: boolean
}

async function handleRename(
  c: Context<AuditEnv, any, any>,
  resolve: SourceContextResolver,
  handle: ItemHandle,
  input: RenameInput,
) {
  // The body was validated against `RenameRequestSchema`: `to` is
  // required; `keepAlias` defaults true.
  const { fromName, to: toName, keepAlias, force } = input

  const source = await resolve(input.target)
  const site = await loadSiteFromSource(source)

  // Dropping the old name's alias takes it off the site, like archiving
  // without one: it needs the delete capability, and refuses while other
  // items still use it unless `?force=true`, as the archive route does.
  if (!keepAlias) {
    const denied = await denyWithoutCapability(c, handle.scopeKind === 'page' ? 'delete:pages' : 'delete:fragments')
    // A 401 or 403 problem (`denyWithoutCapability`).
    if (denied) return denied as ProblemResponse<401 | 403>
  }

  // No-op rename — return 200 quietly so callers can retry without
  // surprise. The author intent ("rename A to A") is satisfied.
  if (fromName === toName) {
    const response: RenameResponse = {
      ok: true,
      name: toName,
      fromName,
      flattenedAliases: [],
      localeVariants: [],
    }
    return c.json(response, 200)
  }

  // Look up the source manifest.
  const fromManifest = lookupManifest(site, handle.scopeKind, fromName)
  if (!fromManifest) {
    return problem(c, 404, 'NOT_FOUND', `${handle.label} "${fromName}" not found`)
  }

  // Conflict checks (Q3 C1) — distinct 409 codes for the two flavors.
  const toManifest = lookupManifest(site, handle.scopeKind, toName)
  if (toManifest) {
    if (toManifest.archived === true) {
      const body: ArchivedNameConflict = {
        code: 'ARCHIVED_NAME_CONFLICT',
        toName,
        conflictKind: 'archived',
        archive: {
          ...(toManifest.archivedAt ? { archivedAt: toManifest.archivedAt } : {}),
          ...(toManifest.archivedBy ? { archivedBy: toManifest.archivedBy } : {}),
          ...(toManifest.aliasOf ? { aliasOf: toManifest.aliasOf } : {}),
        },
      }
      return problemFrom(c, 409, body)
    }
    const body: NameCollision = { code: 'NAME_COLLISION', toName, conflictKind: 'live' }
    return problemFrom(c, 409, body)
  }

  const liveRefs =
    !keepAlias && handle.scopeKind === 'fragment'
      ? findFragmentUsersInSite(site, fromName).map(ref => ({ kind: ref.source, name: ref.name }))
      : []
  if (liveRefs.length > 0 && !force) {
    return problem(c, 409, 'ARCHIVE_HAS_LIVE_REFS', undefined, { liveRefs })
  }

  // Track step progress for I1's RENAME_PARTIAL response.
  const completed: Array<'create-new' | 'archive-old' | 'flatten-cascade'> = []

  // Locale variants for E1/E5: discover what's at the from-name dir.
  const localeEntry = handle.scopeKind === 'page' ? site.pageLocales.get(fromName) : site.fragmentLocales.get(fromName)
  const localeVariants = localeEntry ? [...localeEntry.locales.keys()] : []

  try {
    // ─── Step 1: create-new ─────────────────────────────────────────
    // Copy default manifest + every locale variant to the new path.
    // The new item is live (no archive fields); content stays identical.
    await createNew(source, handle, fromName, toName, fromManifest, localeEntry)
    completed.push('create-new')

    // ─── Step 2: archive-old ────────────────────────────────────────
    // Archive the old name. When keepAlias is true, set aliasOf: toName
    // so render emits 301. When false, pure soft-delete (410 / 404).
    await archiveOld(source, handle, fromName, fromManifest, keepAlias ? toName : undefined, c.var.principal.id)
    completed.push('archive-old')

    // ─── Step 3: flatten cascade ────────────────────────────────────
    // Q3 G1 invariant: any archive whose aliasOf was fromName now
    // points at toName instead. Parallel rewrites — each touches a
    // distinct manifest; no contention.
    const flattened = await flattenAliasChain(source, site, handle, fromName, toName)
    completed.push('flatten-cascade')

    // ─── Cache invalidation ─────────────────────────────────────────
    await Promise.all([
      source.cache.invalidatePrefix(`${handle.scopeKind}s:`),
      handle.scopeKind === 'fragment' ? source.cache.invalidatePrefix('pages:') : Promise.resolve(),
    ])

    // ─── Audit (Q8 H1) ──────────────────────────────────────────────
    // Single composite event. metadata.fromName + flattenedAliases +
    // localeVariants give forensics enough to reconstruct without
    // multi-row joins.
    const metadata: Record<string, unknown> = { fromName, keepAlias }
    if (flattened.length > 0) metadata.flattenedAliases = flattened
    if (localeVariants.length > 0) metadata.localeVariants = localeVariants
    if (liveRefs.length > 0) {
      metadata.forced = true
      metadata.bypassedRefs = liveRefs
    }
    await c.var.audit.record({
      action: 'rename',
      outcome: 'success',
      scope: { kind: handle.scopeKind, name: toName },
      metadata,
    })

    const response: RenameResponse = {
      ok: true,
      name: toName,
      fromName,
      flattenedAliases: flattened,
      localeVariants,
    }
    return c.json(response, 200)
  } catch (err) {
    // Q9 I1: surface partial state. Each step is internally
    // idempotent — retrying the rename re-runs uncompleted steps.
    const allSteps: Array<'create-new' | 'archive-old' | 'flatten-cascade'> = [
      'create-new',
      'archive-old',
      'flatten-cascade',
    ]
    const remaining = allSteps.filter(s => !completed.includes(s))
    // Don't audit partial failures — the audit log records intent +
    // outcome of completed actions. A retry that succeeds will audit
    // normally with the full state. Forensics for the failure window
    // lives in operational logs (per design-logging.md), not audit.
    return problem(c, 500, 'RENAME_PARTIAL', (err as Error).message, { completed, remaining })
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Create the new manifest + all locale variants. Each variant is
 * written as a separate file; dep sidecars (asset-refs, fragment-deps)
 * are materialized via rebuild* calls so the new name's dep index
 * matches the old name's.
 */
async function createNew(
  source: SourceContext,
  handle: ItemHandle,
  fromName: string,
  toName: string,
  fromManifest: PageManifest | FragmentManifest,
  localeEntry:
    | import('../../site-loader.js').LocalizedEntry<(PageManifest | FragmentManifest) & { dir: string }>
    | undefined,
): Promise<void> {
  // Strip the loader's derived fields before persisting — `dir` is a
  // runtime projection, `route` is derived per-call from the directory
  // name (deriveRoute). The rename moves the directory, so route is
  // re-derived correctly on next loadSite without persisting it.
  const newManifest = stripDerivedFields(fromManifest)

  const newDir = source.contentRoot.path(`${handle.scopeKind}s`, toName)
  const newPath = join(newDir, handle.filename)
  await source.storage.mkdir(newDir)
  const serialized = JSON.stringify(newManifest, null, 2) + '\n'

  // History first per the existing PUT pattern.
  if (source.history) {
    await recordWrite({
      history: source.history,
      contentRoot: source.contentRoot,
      operation: 'save',
      items: [{ path: source.contentRoot.relative(newPath), content: serialized }],
    })
  }
  await source.storage.writeFile(newPath, serialized)

  // Locale variants — each as its own file with `page.{locale}.json`
  // / `fragment.{locale}.json` shape.
  if (localeEntry) {
    for (const [locale, variantManifest] of localeEntry.locales) {
      const variantStripped = stripDerivedFields(variantManifest)
      const variantFilename = handle.filename.replace(/\.json$/, `.${locale}.json`)
      const variantPath = join(newDir, variantFilename)
      const variantSerialized = JSON.stringify(variantStripped, null, 2) + '\n'
      if (source.history) {
        await recordWrite({
          history: source.history,
          contentRoot: source.contentRoot,
          operation: 'save',
          items: [{ path: source.contentRoot.relative(variantPath), content: variantSerialized }],
        })
      }
      await source.storage.writeFile(variantPath, variantSerialized)
    }
  }

  // Dep sidecars — the new item references the same assets/fragments
  // as the old item. Rebuild them at the new name.
  const newItem: ItemRef = { source: handle.refSource, name: toName }
  await Promise.all([
    rebuildAssetRefs(source.contentRoot, newItem, null, newManifest),
    rebuildFragmentDeps(source.contentRoot, newItem, null, newManifest),
  ])
  if (localeEntry) {
    const localeRebuilds: Promise<void>[] = []
    for (const [locale, variantManifest] of localeEntry.locales) {
      const variantStripped = stripDerivedFields(variantManifest)
      const variantItem: ItemRef = { source: handle.refSource, name: toName, locale }
      localeRebuilds.push(
        rebuildAssetRefs(source.contentRoot, variantItem, null, variantStripped),
        rebuildFragmentDeps(source.contentRoot, variantItem, null, variantStripped),
      )
    }
    await Promise.all(localeRebuilds)
  }
}

/**
 * Archive the old name. When `aliasTarget` is set (keepAlias=true),
 * sets aliasOf so render emits a 301 to the new name. When undefined
 * (keepAlias=false), pure soft-delete; render emits 410.
 */
async function archiveOld(
  source: SourceContext,
  handle: ItemHandle,
  fromName: string,
  fromManifest: PageManifest | FragmentManifest,
  aliasTarget: string | undefined,
  archivedBy: string,
): Promise<void> {
  const oldDir = source.contentRoot.path(`${handle.scopeKind}s`, fromName)
  const oldPath = join(oldDir, handle.filename)
  const stripped = stripDerivedFields(fromManifest)
  const archived: ComponentManifest = {
    ...stripped,
    archived: true,
    archivedAt: new Date().toISOString(),
    archivedBy,
  }
  if (aliasTarget) archived.aliasOf = aliasTarget
  const serialized = JSON.stringify(archived, null, 2) + '\n'

  if (source.history) {
    await recordWrite({
      history: source.history,
      contentRoot: source.contentRoot,
      operation: 'save',
      items: [{ path: source.contentRoot.relative(oldPath), content: serialized }],
    })
  }
  await source.storage.writeFile(oldPath, serialized)

  // Update the archive-aliases sidecar for the old name's new state.
  const oldItem: ItemRef = { source: handle.refSource, name: fromName }
  await rebuildArchiveAliases(source.contentRoot, oldItem, fromManifest, archived)
}

/**
 * Walk archives where aliasOf === fromName; rewrite each to
 * aliasOf: toName. Returns the names of rewritten archives for the
 * audit trail. The aliasing archives come from the loaded site, not
 * the `.gazetta/alias-targets/` index: derived state isn't committed,
 * so a fresh clone or `git pull` can leave it missing or stale
 * (#1139).
 *
 * Per Q4 D1+D5: synchronous parallel rewrites. Each rewrite touches
 * a distinct manifest; no contention.
 */
async function flattenAliasChain(
  source: SourceContext,
  site: Site,
  handle: ItemHandle,
  fromName: string,
  toName: string,
): Promise<string[]> {
  const aliasingArchives = findArchivesAliasingInSite(site, fromName)
  if (aliasingArchives.length === 0) return []

  // Read each archive's current manifest, rewrite its aliasOf, write
  // back, update the sidecar diff. Filter by source kind to match
  // ItemHandle (page archives can alias pages; fragment archives can
  // alias fragments — we don't cross the boundary).
  const rewrites = aliasingArchives
    .filter(ref => ref.source === handle.refSource)
    .map(async ref => {
      const dir = source.contentRoot.path(`${handle.scopeKind}s`, ref.name)
      const path = join(dir, ref.locale ? handle.filename.replace(/\.json$/, `.${ref.locale}.json`) : handle.filename)
      const raw = await source.storage.readFile(path)
      const oldManifest = JSON.parse(raw) as ComponentManifest
      const newManifest: ComponentManifest = { ...oldManifest, aliasOf: toName }
      const serialized = JSON.stringify(newManifest, null, 2) + '\n'

      if (source.history) {
        await recordWrite({
          history: source.history,
          contentRoot: source.contentRoot,
          operation: 'save',
          items: [{ path: source.contentRoot.relative(path), content: serialized }],
        })
      }
      await source.storage.writeFile(path, serialized)
      await rebuildArchiveAliases(source.contentRoot, ref, oldManifest, newManifest)
      return ref.name
    })

  return Promise.all(rewrites)
}

/**
 * Strip the loader's derived fields. `dir` is the absolute storage
 * path; `route` is computed per-call from the directory name. Both
 * are runtime projections that don't belong in the persisted JSON.
 */
function stripDerivedFields(manifest: PageManifest | FragmentManifest): ComponentManifest {
  const stripped = { ...manifest } as ComponentManifest & Record<string, unknown>
  delete stripped.dir
  // `route` is derived per-call from the directory name — drop it so
  // the loader recomputes after rename. Locale variants have their
  // route derived as `prefix + parent.route`, also recomputed.
  delete stripped.route
  return stripped
}
