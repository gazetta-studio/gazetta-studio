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
import { Hono } from 'hono'
import { deleteAsset } from '../../assets/delete.js'
import { ingestAsset } from '../../assets/ingest.js'
import { listAssets, toSummary } from '../../assets/list.js'
import { readManifest } from '../../assets/manifest.js'
import { renameAsset } from '../../assets/rename.js'
import { replaceAsset } from '../../assets/replace.js'
import { respondWithAssetError } from '../error-response.js'
import type { SourceContextResolver } from '../source-context.js'

/** Where assets live, relative to the target storage root. */
const ASSETS_ROOT = 'assets'

export function assetRoutes(resolve: SourceContextResolver) {
  const app = new Hono()

  app.get('/api/assets', async c => {
    const source = await resolve(c.req.query('target'))
    try {
      const summaries = await listAssets({
        storage: source.storage,
        assetsRoot: ASSETS_ROOT,
      })
      return c.json(summaries)
    } catch (err) {
      const res = respondWithAssetError(c, err)
      if (res) return res
      throw err
    }
  })

  app.get('/api/assets/:name', async c => {
    const name = c.req.param('name')
    const source = await resolve(c.req.query('target'))
    try {
      const manifest = await readManifest(source.storage, ASSETS_ROOT, name)
      return c.json(toSummary(manifest))
    } catch (err) {
      const res = respondWithAssetError(c, err)
      if (res) return res
      throw err
    }
  })

  app.delete('/api/assets/:name', async c => {
    const name = c.req.param('name')
    const source = await resolve(c.req.query('target'))
    try {
      await deleteAsset({
        storage: source.storage,
        assetsRoot: ASSETS_ROOT,
        siteDir: source.siteDir,
        assetName: name,
        manifest: source.manifest,
        history: source.history,
        contentRoot: source.contentRoot,
      })
      // 204 No Content — standard REST for successful delete with no body.
      return c.body(null, 204)
    } catch (err) {
      const res = respondWithAssetError(c, err)
      if (res) return res
      throw err
    }
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
  app.post('/api/assets/:name/rename-to/:newName', async c => {
    const oldName = c.req.param('name')
    const newName = c.req.param('newName')
    const source = await resolve(c.req.query('target'))
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
      const res = respondWithAssetError(c, err)
      if (res) return res
      throw err
    }
  })

  app.post('/api/assets/:name/replace-with/:newName', async c => {
    const oldName = c.req.param('name')
    const newName = c.req.param('newName')
    const source = await resolve(c.req.query('target'))
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
      const res = respondWithAssetError(c, err)
      if (res) return res
      throw err
    }
  })

  app.post('/api/assets', async c => {
    const source = await resolve(c.req.query('target'))

    // Hono's parseBody reads multipart into a { [field]: string | File } map.
    const body = await c.req.parseBody()
    const file = body.file
    const name = body.name
    const altRaw = body.alt

    if (!(file instanceof File)) {
      return c.json({ code: 'BAD_REQUEST', message: 'Missing or invalid "file" field' }, 400)
    }
    if (typeof name !== 'string' || name.length === 0) {
      return c.json({ code: 'BAD_REQUEST', message: 'Missing or invalid "name" field' }, 400)
    }
    // alt: absent → null, empty string → "" (decorative), string → the value
    const alt = typeof altRaw === 'string' ? altRaw : null

    // Pull per-target upload policy from site.yaml. When the source
    // didn't resolve a named target (legacy static-resolver path) or
    // the site manifest isn't wired, ingest falls back to the default
    // size cap.
    const targetConfig = source.targetName ? source.manifest?.targets?.[source.targetName] : undefined
    const policy = targetConfig?.assets

    try {
      const result = await ingestAsset({
        storage: source.storage,
        assetsRoot: ASSETS_ROOT,
        bytes: file.stream(),
        requestedName: name,
        alt,
        uploadedBy: '',
        policy,
        history: source.history,
        contentRoot: source.contentRoot,
      })
      return c.json({ manifest: result.manifest, bytesPath: result.bytesPath }, 201)
    } catch (err) {
      const res = respondWithAssetError(c, err)
      if (res) return res
      throw err
    }
  })

  return app
}
