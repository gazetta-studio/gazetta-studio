/**
 * HTTP routes for `/api/assets*`.
 *
 * Thin adapters. Each handler:
 *   1. resolves the active target's source context,
 *   2. delegates to the appropriate asset-domain operation,
 *   3. maps success to the HTTP response,
 *   4. delegates error-to-response translation to `respondWithAssetError`.
 *
 * No validation, storage, or orchestration logic in here — the asset
 * domain owns all of that (see `src/assets/`).
 */
import { createRoute, z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { problem, type ProblemResponse } from '../problem.js'
import { enumerateOverrideSlices } from '../../assets/asset-paths.js'
import { deleteAsset } from '../../assets/delete.js'
import { ingestAsset } from '../../assets/ingest.js'
import { ingestLocaleBytes } from '../../assets/ingest-locale.js'
import { listAssets, toSummary } from '../../assets/list.js'
import { readManifest } from '../../assets/manifest.js'
import { removeOverride } from '../../assets/remove-override.js'
import { renameAsset } from '../../assets/rename.js'
import { replaceAsset } from '../../assets/replace.js'
import { updateAssetMetadata } from '../../assets/update-metadata.js'
import { buildSelector, type Selector } from '../../schema/dimensions.js'
import { isValidLocale } from '../../locale.js'
import { isValidTheme } from '../../themes.js'
import { suggestAltForAsset } from '../../alt/route-handler.js'
import { respondWithAssetError } from '../error-response.js'
import { loadSiteFromSource, type SourceContextResolver } from '../source-context.js'
import { requireCapability } from '../middleware/capability.js'
import { requireEditableTarget } from '../middleware/editable-target.js'
import type { AuditEnv } from '../middleware/audit.js'
import {
  buildHookContext,
  dispatchAfterUpload,
  dispatchBeforeUpload,
  HookCancellation,
  HookTimeout,
  type HookRegistry,
  type UploadHookAsset,
} from '../../hooks/index.js'
import { makeAuditFiringEmitter } from '../hook-audit-emitter.js'
import type { AssetErrorHttpStatus } from '../../assets/errors.js'
import type { AssetManifest } from '../../schema/types.js'
import type { StorageProvider } from '../../types.js'
import { apiApp, json, problems } from '../openapi.js'
import {
  AssetMetadataPatchSchema,
  AssetMetadataResponseSchema,
  AssetNameParamSchema,
  AssetRenameParamSchema,
  AssetSelectorQuerySchema,
  AssetSummarySchema,
  AssetUploadFormSchema,
  AssetUploadResponseSchema,
  LocaleBytesFormSchema,
  LocaleBytesUploadResponseSchema,
  SuggestAltQuerySchema,
  SuggestAltResponseSchema,
} from '../schemas/assets.js'
import { TargetQuerySchema } from '../schemas/target-query.js'

export interface AssetRoutesOptions {
  hooks?: HookRegistry
}

/**
 * Pull a Selector out of the request's query params, validating each
 * dimension's value as it reads. Returns `null` when no dimension is
 * set; throws a Response with a 400 body when any value is malformed.
 *
 * Per design, locale codes are BCP 47 (lowercase) and theme codes are
 * lowercase ASCII non-locale tokens. Reuses the same validators used
 * for filename parsing.
 */
function selectorFromQuery(
  c: Context,
  { locale, theme }: { locale?: string; theme?: string },
): Selector | null | ProblemResponse<400> {
  if (locale === undefined && theme === undefined) return null
  if (locale !== undefined && !isValidLocale(locale)) {
    return problem(c, 400, 'BAD_REQUEST', `Invalid locale code: ${locale}`)
  }
  if (theme !== undefined && !isValidTheme(theme)) {
    return problem(c, 400, 'BAD_REQUEST', `Invalid theme code: ${theme}`)
  }
  return buildSelector({
    ...(locale !== undefined ? { locale } : {}),
    ...(theme !== undefined ? { theme } : {}),
  })
}

/** Where assets live, relative to the target storage root. */
const ASSETS_ROOT = 'assets'

/**
 * Answer an asset-domain error as its problem; rethrow anything else so
 * the app's error handler answers a 500.
 */
function assetProblem<S extends AssetErrorHttpStatus = AssetErrorHttpStatus>(
  c: Context,
  err: unknown,
): ProblemResponse<S> {
  const res = respondWithAssetError(c, err)
  if (res) return res as ProblemResponse<S>
  throw err
}

/**
 * PATCH /api/assets/:name's body checks, run before the schema so a bad
 * body answers the same messages it did before the route had one.
 */
const checkMetadataPatch = createMiddleware(async (c, next) => {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return problem(c, 400, 'BAD_REQUEST', 'Invalid JSON body')
  }
  const wrong = metadataPatchProblem(raw)
  if (wrong) return problem(c, 400, 'BAD_REQUEST', wrong)
  await next()
})

/** What's wrong with a PATCH body, or null when it's a valid patch. */
function metadataPatchProblem(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'Body must be an object'
  const body = raw as Record<string, unknown>
  if ('alt' in body && body.alt !== null && typeof body.alt !== 'string') return 'alt must be string or null'
  if ('focalPoint' in body && body.focalPoint !== null) {
    const v = body.focalPoint
    if (
      typeof v !== 'object' ||
      typeof (v as Record<string, unknown>).x !== 'number' ||
      typeof (v as Record<string, unknown>).y !== 'number'
    ) {
      return 'focalPoint must be { x: number, y: number } or null'
    }
    const fp = v as { x: number; y: number }
    if (fp.x < 0 || fp.x > 1 || fp.y < 0 || fp.y > 1) return 'focalPoint x and y must be in [0, 1]'
  }
  return null
}

/** Override locales and themes of an asset, for its summary. */
async function overridesOf(storage: StorageProvider, manifest: AssetManifest) {
  const slices = await enumerateOverrideSlices(storage, ASSETS_ROOT, manifest)
  const locales: string[] = []
  const themes: string[] = []
  for (const slice of slices) {
    const locale = slice.selector.get('locale')
    const theme = slice.selector.get('theme')
    if (locale !== undefined && !locales.includes(locale)) locales.push(locale)
    if (theme !== undefined && !themes.includes(theme)) themes.push(theme)
  }
  return { locales, themes }
}

const listAssetsRoute = createRoute({
  method: 'get',
  path: '/api/assets',
  summary: 'The assets on a target',
  middleware: [requireCapability('read:assets')] as const,
  request: { query: TargetQuerySchema },
  responses: {
    200: json(z.array(AssetSummarySchema), 'The assets'),
    ...problems({ 401: ['UNAUTHENTICATED'], 403: ['FORBIDDEN'], 500: ['ASSET_STORAGE_FAILURE'] }),
  },
})

const getAssetRoute = createRoute({
  method: 'get',
  path: '/api/assets/:name',
  summary: 'An asset',
  middleware: [requireCapability('read:assets')] as const,
  request: { params: AssetNameParamSchema, query: TargetQuerySchema },
  responses: {
    200: json(AssetSummarySchema, 'The asset, with its override locales and themes'),
    ...problems({
      400: ['ASSET_NAME_INVALID', 'ASSET_PATH_TRAVERSAL'],
      401: ['UNAUTHENTICATED'],
      403: ['FORBIDDEN'],
      404: ['ASSET_MANIFEST_NOT_FOUND'],
      500: ['ASSET_MANIFEST_CORRUPT', 'ASSET_STORAGE_FAILURE'],
    }),
  },
})

export function assetRoutes(resolve: SourceContextResolver, opts: AssetRoutesOptions = {}) {
  const editableTarget = requireEditableTarget(resolve)
  const app = apiApp<AuditEnv>()
  const hooks = opts.hooks

  /**
   * PATCH /api/assets/:name — update asset metadata.
   *
   * Today's surface: alt only (per design-media.md three-state model).
   * Future: tags, title, description, focalPoint at the asset level.
   *
   * Wire shape preserves three-state alt:
   *   `{}`              — no change to alt
   *   `{"alt": "text"}` — meaningful description
   *   `{"alt": ""}`     — decorative
   *   `{"alt": null}`   — explicitly cleared (resolver falls back to '')
   *
   * Responses:
   *   200 OK            — { manifest }  (updated summary)
   *   400 Bad Request   — alt isn't string|null
   *   404 Not Found     — asset missing
   *   500 Storage       — underlying write failed
   */
  const patchAssetRoute = createRoute({
    method: 'patch',
    path: '/api/assets/:name',
    summary: "Update an asset's alt text or focal point",
    middleware: [requireCapability('edit:assets'), editableTarget, checkMetadataPatch] as const,
    request: {
      params: AssetNameParamSchema,
      query: TargetQuerySchema,
      body: { content: { 'application/json': { schema: AssetMetadataPatchSchema } } },
    },
    responses: {
      200: json(AssetMetadataResponseSchema, 'The updated asset'),
      ...problems({
        400: ['BAD_REQUEST', 'ASSET_NAME_INVALID', 'ASSET_PATH_TRAVERSAL'],
        401: ['UNAUTHENTICATED'],
        403: ['FORBIDDEN', 'TARGET_NOT_EDITABLE'],
        404: ['ASSET_MANIFEST_NOT_FOUND'],
        415: ['BAD_REQUEST'],
        500: ['ASSET_MANIFEST_CORRUPT', 'ASSET_STORAGE_FAILURE'],
      }),
    },
  })

  const deleteAssetRoute = createRoute({
    method: 'delete',
    path: '/api/assets/:name',
    summary: 'Delete an asset nothing uses',
    middleware: [requireCapability('delete:assets'), editableTarget] as const,
    request: { params: AssetNameParamSchema, query: TargetQuerySchema },
    responses: {
      204: { description: 'Deleted' },
      ...problems({
        400: ['ASSET_NAME_INVALID', 'ASSET_PATH_TRAVERSAL'],
        401: ['UNAUTHENTICATED'],
        403: ['FORBIDDEN', 'TARGET_NOT_EDITABLE'],
        404: ['ASSET_MANIFEST_NOT_FOUND'],
        409: ['ASSET_IN_USE'],
        500: ['ASSET_MANIFEST_CORRUPT', 'ASSET_STORAGE_FAILURE'],
      }),
    },
  })

  /**
   * POST /api/assets/:name/rename-to/:newName — atomic rename.
   *
   * Copies bytes + variants + manifest to `:newName`, rewrites every
   * reference across pages + fragments, and deletes the old asset.
   * One history revision covers the whole operation. URLs to the old
   * asset stay valid until refs are rewritten — safe-order per design.
   *
   * Responses:
   *   204 No Content        — success
   *   404 Not Found         — old asset missing
   *   409 Name Collision    — new name already taken
   *   500 Storage Failure   — underlying read/write/rm failed mid-operation
   */
  const renameAssetRoute = createRoute({
    method: 'post',
    path: '/api/assets/:name/rename-to/:newName',
    summary: 'Rename an asset and every reference to it',
    middleware: [requireCapability('edit:assets'), editableTarget] as const,
    request: { params: AssetRenameParamSchema, query: TargetQuerySchema },
    responses: {
      204: { description: 'Renamed' },
      ...problems({
        400: ['ASSET_NAME_INVALID', 'ASSET_NAME_RESERVED', 'ASSET_PATH_TRAVERSAL'],
        401: ['UNAUTHENTICATED'],
        403: ['FORBIDDEN', 'TARGET_NOT_EDITABLE'],
        404: ['ASSET_MANIFEST_NOT_FOUND'],
        409: ['ASSET_NAME_COLLISION'],
        500: ['ASSET_MANIFEST_CORRUPT', 'ASSET_STORAGE_FAILURE'],
      }),
    },
  })

  /**
   * POST /api/assets/:name/replace-with/:newName — atomic replace.
   *
   * Rewrites every reference to `:name` across pages + fragments to
   * point at `:newName`, then deletes the old asset. One history
   * revision covers the whole operation.
   *
   * Responses:
   *   204 No Content        — success
   *   404 Not Found         — either asset missing
   *   409 Kind Mismatch     — kinds/MIME-categories differ
   *   500 Storage Failure   — underlying write/rm failed mid-operation
   */
  const replaceAssetRoute = createRoute({
    method: 'post',
    path: '/api/assets/:name/replace-with/:newName',
    summary: 'Point every reference at another asset, then delete this one',
    middleware: [requireCapability('edit:assets'), editableTarget] as const,
    request: { params: AssetRenameParamSchema, query: TargetQuerySchema },
    responses: {
      204: { description: 'Replaced' },
      ...problems({
        400: ['ASSET_NAME_INVALID', 'ASSET_PATH_TRAVERSAL'],
        401: ['UNAUTHENTICATED'],
        403: ['FORBIDDEN', 'TARGET_NOT_EDITABLE'],
        404: ['ASSET_MANIFEST_NOT_FOUND'],
        409: ['ASSET_KIND_MISMATCH'],
        500: ['ASSET_MANIFEST_CORRUPT', 'ASSET_STORAGE_FAILURE'],
      }),
    },
  })

  /**
   * POST /api/assets/:name/suggest-alt — generate alt text for the
   * named asset using the configured AI adapter.
   *
   * Server fetches asset bytes from storage; client only passes the
   * name and target. Locale (?locale=fr) controls the language the
   * model writes in (direct generation, no translation pipeline).
   *
   * Refusals return 200 with `{ refused: true, refusalReason }` —
   * the API call succeeded; the model declined. UI consumers branch
   * on `refused` to decide whether to surface the text or the reason.
   *
   * Responses:
   *   200 OK            — { text, refused, refusalReason }
   *   400 Bad Request   — invalid locale code
   *   404 Not Found     — asset doesn't exist on this target
   *   502 Bad Gateway   — adapter call failed (network, auth, etc.)
   *   503 Unavailable   — no adapter configured / MIME unsupported
   */
  const suggestAltRoute = createRoute({
    method: 'post',
    path: '/api/assets/:name/suggest-alt',
    summary: 'Suggest alt text for an asset with the configured AI provider',
    middleware: [requireCapability('edit:assets')] as const,
    request: { params: AssetNameParamSchema, query: SuggestAltQuerySchema },
    responses: {
      200: json(SuggestAltResponseSchema, 'The suggestion, or why the model declined'),
      ...problems({
        400: ['BAD_REQUEST', 'ASSET_NAME_INVALID', 'ASSET_PATH_TRAVERSAL'],
        401: ['UNAUTHENTICATED'],
        403: ['FORBIDDEN'],
        404: ['ASSET_MANIFEST_NOT_FOUND'],
        500: ['ASSET_MANIFEST_CORRUPT', 'ASSET_STORAGE_FAILURE'],
        502: ['AI_ADAPTER_FAILED'],
        503: ['AI_ADAPTER_UNAVAILABLE'],
      }),
    },
  })

  /**
   * POST /api/assets/:name/locale-bytes — upload a locale (or theme,
   * or compound) bytes override for an existing asset.
   *
   * Selector encoded as query: `?locale=fr` or `?locale=fr&theme=dark`.
   * Both absent is a 400 — this route exists to write a non-default
   * selector. Default-bytes upload uses POST /api/assets.
   *
   * Responses:
   *   201 Created           — { manifest, bytesPath }
   *   400 Bad Request       — invalid selector or empty selector
   *   404 Not Found         — asset doesn't exist
   *   409 Kind Mismatch     — override MIME category differs from default
   *   500 Storage Failure   — underlying write failed
   */
  const uploadLocaleBytesRoute = createRoute({
    method: 'post',
    path: '/api/assets/:name/locale-bytes',
    summary: "Upload an asset's bytes for a locale or theme",
    middleware: [requireCapability('edit:assets'), editableTarget] as const,
    request: {
      params: AssetNameParamSchema,
      query: AssetSelectorQuerySchema,
      body: { content: { 'multipart/form-data': { schema: LocaleBytesFormSchema } } },
    },
    responses: {
      201: json(LocaleBytesUploadResponseSchema, 'The override manifest and where its bytes are'),
      ...problems({
        400: [
          'BAD_REQUEST',
          'ASSET_NAME_INVALID',
          'ASSET_PATH_TRAVERSAL',
          'ASSET_SIZE_EXCEEDED',
          'ASSET_MIME_MISMATCH',
          'ASSET_PREPROCESS_FAILED',
          'ASSET_VARIANT_GENERATION_FAILED',
        ],
        401: ['UNAUTHENTICATED'],
        403: ['FORBIDDEN', 'TARGET_NOT_EDITABLE'],
        404: ['ASSET_MANIFEST_NOT_FOUND'],
        409: ['ASSET_KIND_MISMATCH'],
        415: ['BAD_REQUEST'],
        500: ['ASSET_MANIFEST_CORRUPT', 'ASSET_MIME_UNSUPPORTED', 'ASSET_STORAGE_FAILURE'],
      }),
    },
  })

  /**
   * DELETE /api/assets/:name/locale-bytes — remove one locale (or
   * theme, or compound) bytes override. The default asset is unaffected;
   * the locale falls back to default bytes after removal.
   *
   * Selector encoded as query (same shape as POST). Both absent is a
   * 400 — to delete the default asset, use DELETE /api/assets/:name.
   *
   * Responses:
   *   204 No Content        — success
   *   400 Bad Request       — invalid or empty selector
   *   404 Not Found         — asset or override doesn't exist
   *   500 Storage Failure   — underlying rm failed
   */
  const removeLocaleBytesRoute = createRoute({
    method: 'delete',
    path: '/api/assets/:name/locale-bytes',
    summary: "Remove an asset's bytes for a locale or theme",
    middleware: [requireCapability('edit:assets'), editableTarget] as const,
    request: { params: AssetNameParamSchema, query: AssetSelectorQuerySchema },
    responses: {
      204: { description: 'Removed; the locale or theme falls back to the default bytes' },
      ...problems({
        400: ['BAD_REQUEST', 'ASSET_NAME_INVALID', 'ASSET_PATH_TRAVERSAL'],
        401: ['UNAUTHENTICATED'],
        403: ['FORBIDDEN', 'TARGET_NOT_EDITABLE'],
        404: ['ASSET_MANIFEST_NOT_FOUND'],
        500: ['ASSET_MANIFEST_CORRUPT', 'ASSET_STORAGE_FAILURE'],
      }),
    },
  })

  const uploadAssetRoute = createRoute({
    method: 'post',
    path: '/api/assets',
    summary: 'Upload a new asset',
    middleware: [requireCapability('edit:assets'), editableTarget] as const,
    request: {
      query: TargetQuerySchema,
      body: { content: { 'multipart/form-data': { schema: AssetUploadFormSchema } } },
    },
    responses: {
      201: json(AssetUploadResponseSchema, 'The new asset manifest and where its bytes are'),
      ...problems({
        400: [
          'BAD_REQUEST',
          'ASSET_NAME_INVALID',
          'ASSET_NAME_RESERVED',
          'ASSET_PATH_TRAVERSAL',
          'ASSET_SIZE_EXCEEDED',
          'ASSET_MIME_MISMATCH',
          'ASSET_PREPROCESS_FAILED',
          'ASSET_VARIANT_GENERATION_FAILED',
        ],
        401: ['UNAUTHENTICATED'],
        403: ['FORBIDDEN', 'TARGET_NOT_EDITABLE'],
        409: ['HOOK_CANCELLED', 'ASSET_NAME_COLLISION'],
        415: ['BAD_REQUEST'],
        500: ['AUDIT_FAILED', 'ASSET_MIME_UNSUPPORTED', 'ASSET_STORAGE_FAILURE'],
      }),
    },
  })

  app.openapi(listAssetsRoute, async c => {
    const source = await resolve(c.req.valid('query').target)
    try {
      const summaries = await listAssets({
        storage: source.storage,
        assetsRoot: ASSETS_ROOT,
      })
      return c.json(summaries, 200)
    } catch (err) {
      return assetProblem<500>(c, err)
    }
  })

  app.openapi(getAssetRoute, async c => {
    const { name } = c.req.valid('param')
    const source = await resolve(c.req.valid('query').target)
    try {
      const manifest = await readManifest(source.storage, ASSETS_ROOT, name)
      // Single-asset GET — discover overrides via the targeted scan.
      // Cheaper than the full list scan (one readDir of the asset's
      // parent dir) and gives the detail pane its locale chips without
      // a second round-trip.
      const { locales, themes } = await overridesOf(source.storage, manifest)
      return c.json(toSummary(manifest, locales, themes), 200)
    } catch (err) {
      return assetProblem<400 | 404 | 500>(c, err)
    }
  })

  app.openapi(patchAssetRoute, async c => {
    const { name } = c.req.valid('param')
    const source = await resolve(c.req.valid('query').target)
    // `checkMetadataPatch` has answered the body's own messages; the
    // schema keeps only `alt` and `focalPoint`, each when present.
    const patch = c.req.valid('json')

    try {
      const updated = await updateAssetMetadata({
        storage: source.storage,
        assetsRoot: ASSETS_ROOT,
        assetName: name,
        patch,
        history: source.history,
        contentRoot: source.contentRoot,
      })
      // Re-summarize with override locales so the client refresh shape
      // matches GET. Single-asset case uses the same enumerator.
      const { locales, themes } = await overridesOf(source.storage, updated)
      return c.json({ manifest: toSummary(updated, locales, themes) }, 200)
    } catch (err) {
      return assetProblem<400 | 404 | 500>(c, err)
    }
  })

  app.openapi(deleteAssetRoute, async c => {
    const { name } = c.req.valid('param')
    const source = await resolve(c.req.valid('query').target)
    try {
      await deleteAsset({
        storage: source.storage,
        assetsRoot: ASSETS_ROOT,
        siteDir: source.siteDir,
        assetName: name,
        manifest: source.manifest,
        history: source.history,
        contentRoot: source.contentRoot,
        // Load the site through the source's cache when the source has a
        // manifest; manifest-less sources fall through to deleteAsset's
        // own load with its `(refs-scan)` fallback (#1139).
        site: source.manifest ? await loadSiteFromSource(source) : undefined,
      })
      // 204 No Content — standard REST for successful delete with no body.
      return c.body(null, 204)
    } catch (err) {
      return assetProblem(c, err)
    }
  })

  app.openapi(renameAssetRoute, async c => {
    const { name: oldName, newName } = c.req.valid('param')
    const source = await resolve(c.req.valid('query').target)
    try {
      await renameAsset({
        storage: source.storage,
        assetsRoot: ASSETS_ROOT,
        siteDir: source.siteDir,
        oldName,
        newName,
        manifest: source.manifest,
        history: source.history,
        contentRoot: source.contentRoot,
      })
      return c.body(null, 204)
    } catch (err) {
      return assetProblem(c, err)
    }
  })

  app.openapi(replaceAssetRoute, async c => {
    const { name: oldName, newName } = c.req.valid('param')
    const source = await resolve(c.req.valid('query').target)
    try {
      await replaceAsset({
        storage: source.storage,
        assetsRoot: ASSETS_ROOT,
        siteDir: source.siteDir,
        oldName,
        newName,
        manifest: source.manifest,
        history: source.history,
      })
      return c.body(null, 204)
    } catch (err) {
      return assetProblem(c, err)
    }
  })

  app.openapi(suggestAltRoute, async c => {
    const { name } = c.req.valid('param')
    const query = c.req.valid('query')
    const localeRaw = query.locale
    if (localeRaw !== undefined && !isValidLocale(localeRaw)) {
      return problem(c, 400, 'BAD_REQUEST', `Invalid locale code: ${localeRaw}`)
    }
    const locale = localeRaw ?? 'en'

    const source = await resolve(query.target)
    if (!source.manifest) {
      // Without the site manifest we can't read `ai:` / `altText:`
      // config. Treat as unconfigured rather than failing — same
      // posture as a missing block.
      return problem(c, 503, 'AI_ADAPTER_UNAVAILABLE', 'Site manifest not available; AI alt-text not configured.')
    }

    const targetConfig = source.targetName ? source.manifest.targets?.[source.targetName] : undefined

    try {
      const result = await suggestAltForAsset({
        name,
        assetsRoot: ASSETS_ROOT,
        storage: source.storage,
        site: source.manifest,
        target: targetConfig,
        gazetta: source.gazettaManifest,
        locale,
      })

      switch (result.kind) {
        case 'ok': {
          // Audit the suggest-alt invocation per design-ai.md +
          // cross-foundation gap #4. Refusal is recorded as
          // metadata.refused: true (the API call succeeded; the
          // model declined — outcome stays 'success'). Provider
          // name + locale + refusalReason carried in metadata so
          // forensic queries can answer "why did this image not
          // get alt?" without re-fetching context.
          await c.var.audit.record({
            action: 'ai-suggest-alt',
            outcome: 'success',
            scope: { kind: 'asset', name },
            metadata: {
              provider: result.provider,
              locale,
              refused: result.suggestion.refused,
              ...(result.suggestion.refused && result.suggestion.refusalReason
                ? { refusalReason: result.suggestion.refusalReason }
                : {}),
            },
          })
          return c.json(result.suggestion, 200)
        }
        case 'unavailable':
          return problem(c, 503, 'AI_ADAPTER_UNAVAILABLE', result.message)
        case 'failed':
          return problem(c, 502, 'AI_ADAPTER_FAILED', result.message)
        case 'not-found':
          return problem(c, 404, 'ASSET_MANIFEST_NOT_FOUND', result.message)
      }
    } catch (err) {
      return assetProblem<400 | 404 | 500>(c, err)
    }
  })

  app.openapi(uploadLocaleBytesRoute, async c => {
    const { name } = c.req.valid('param')
    const query = c.req.valid('query')
    const selectorOrErr = selectorFromQuery(c, query)
    if (selectorOrErr instanceof Response) return selectorOrErr
    if (selectorOrErr === null) {
      return problem(c, 400, 'BAD_REQUEST', 'Selector required (locale and/or theme)')
    }

    const source = await resolve(query.target)
    const file = c.req.valid('form').file
    if (!(file instanceof File)) {
      return problem(c, 400, 'BAD_REQUEST', 'Missing or invalid "file" field')
    }

    const targetConfig = source.targetName ? source.manifest?.targets?.[source.targetName] : undefined
    const policy = targetConfig?.assets

    try {
      const result = await ingestLocaleBytes({
        storage: source.storage,
        assetsRoot: ASSETS_ROOT,
        assetName: name,
        selector: selectorOrErr,
        bytes: file.stream(),
        policy,
        history: source.history,
        contentRoot: source.contentRoot,
      })
      return c.json({ manifest: result.manifest, bytesPath: result.bytesPath }, 201)
    } catch (err) {
      return assetProblem(c, err)
    }
  })

  app.openapi(removeLocaleBytesRoute, async c => {
    const { name } = c.req.valid('param')
    const query = c.req.valid('query')
    const selectorOrErr = selectorFromQuery(c, query)
    if (selectorOrErr instanceof Response) return selectorOrErr
    if (selectorOrErr === null) {
      return problem(c, 400, 'BAD_REQUEST', 'Selector required (locale and/or theme)')
    }

    const source = await resolve(query.target)
    try {
      await removeOverride({
        storage: source.storage,
        assetsRoot: ASSETS_ROOT,
        siteDir: source.siteDir,
        assetName: name,
        selector: selectorOrErr,
        history: source.history,
        contentRoot: source.contentRoot,
        author: '',
      })
      return c.body(null, 204)
    } catch (err) {
      return assetProblem<400 | 404 | 500>(c, err)
    }
  })

  app.openapi(uploadAssetRoute, async c => {
    const source = await resolve(c.req.valid('query').target)

    const { file, name, alt: altRaw } = c.req.valid('form')

    if (!(file instanceof File)) {
      return problem(c, 400, 'BAD_REQUEST', 'Missing or invalid "file" field')
    }
    if (typeof name !== 'string' || name.length === 0) {
      return problem(c, 400, 'BAD_REQUEST', 'Missing or invalid "name" field')
    }
    // alt: absent → null, empty string → "" (decorative), string → the value
    const alt = typeof altRaw === 'string' ? altRaw : null

    // Pull per-target upload policy from site.config.ts. When the source
    // didn't resolve a named target (legacy static-resolver path) or
    // the site manifest isn't wired, ingest falls back to the default
    // size cap.
    const targetConfig = source.targetName ? source.manifest?.targets?.[source.targetName] : undefined
    const policy = targetConfig?.assets

    // beforeUpload hooks per design-hooks.md "Asset lifecycle".
    // Cut 6 wires hooks BEFORE the ingest pipeline (which runs the
    // existing UploadPreprocessor + UploadAnalyzer internally).
    // Hooks see raw bytes + initial metadata; their mutations flow
    // into ingestAsset.
    //
    // Design's "hooks AFTER preprocessor/analyzer" goal would
    // require ingestAsset to expose internal hook points; deferred
    // until concrete operator demand for analyzer-extracted EXIF
    // / dimensions in beforeUpload. Operators inspecting analyzer
    // output today use afterUpload (sees the persisted manifest).
    let uploadBytes: Uint8Array
    try {
      uploadBytes = new Uint8Array(await file.arrayBuffer())
    } catch (err) {
      return problem(c, 400, 'BAD_REQUEST', `Failed to read file bytes: ${(err as Error).message}`)
    }
    let initialAsset: UploadHookAsset = {
      name,
      mime: file.type || 'application/octet-stream',
      size: uploadBytes.byteLength,
      ...(alt !== null ? { alt } : {}),
    }
    const hookCtx = hooks
      ? buildHookContext({
          principal: c.var.principal,
          storage: source.storage,
          target: source.targetName,
          requestId: c.req.header('x-request-id') ?? crypto.randomUUID(),
          site: { name: source.manifest?.name },
          auditEmit: makeAuditFiringEmitter(c.var.audit),
        })
      : null
    if (hooks && hookCtx) {
      try {
        const mutated = await dispatchBeforeUpload(hooks, initialAsset, uploadBytes, hookCtx)
        initialAsset = mutated.asset
        uploadBytes = mutated.bytes
      } catch (err) {
        if (err instanceof HookCancellation || err instanceof HookTimeout) {
          return problem(c, 409, 'HOOK_CANCELLED', undefined, { hook: err.hookName, reason: err.message })
        }
        throw err
      }
    }

    // Strict audit mode (#1393, design-audit.md "Strict mode
    // opt-in"): record the upload event BEFORE ingest writes
    // anything; a failed recording refuses the upload. The upload
    // has no always-on audit event today (that is #1392's scope);
    // this record exists only when strict mode requires it.
    const strictPreRecord = c.var.audit?.strict === true
    if (strictPreRecord) {
      const preResult = await c.var.audit.record({
        action: 'save',
        outcome: 'success',
        scope: { kind: 'asset', name: initialAsset.name },
      })
      if (preResult.failed > 0) {
        return problem(c, 500, 'AUDIT_FAILED', 'Audit recording failed; upload refused (strict mode)')
      }
    }

    try {
      const result = await ingestAsset({
        storage: source.storage,
        assetsRoot: ASSETS_ROOT,
        // Wrap the (possibly hook-mutated) bytes back into a stream
        // for ingestAsset's stream-shaped contract. One chunk; the
        // bytes are already in memory (we materialized above).
        bytes: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(uploadBytes)
            controller.close()
          },
        }),
        requestedName: initialAsset.name,
        alt: initialAsset.alt ?? null,
        uploadedBy: '',
        policy,
        history: source.history,
        contentRoot: source.contentRoot,
      })
      // afterUpload hooks per design-hooks.md "Asset lifecycle"
      // step 5. Observational; failures logged. Sees the persisted
      // hash + final manifest fields (via the asset shape).
      if (hooks && hookCtx) {
        await dispatchAfterUpload(
          hooks,
          {
            ...initialAsset,
            // Manifest's hash is the canonical post-ingest digest.
            // initialAsset.size + name passed through unchanged.
          },
          { asset: initialAsset, hash: result.manifest.hash ?? '' },
          hookCtx,
        )
      }
      return c.json({ manifest: result.manifest, bytesPath: result.bytesPath }, 201)
    } catch (err) {
      // Under strict mode the pre-write event already claims the
      // upload; a second event records the failure (#1393).
      if (strictPreRecord) {
        await c.var.audit.record({
          action: 'save',
          outcome: 'write-failed',
          scope: { kind: 'asset', name: initialAsset.name },
        })
      }
      return assetProblem<400 | 409 | 500>(c, err)
    }
  })

  return app
}
