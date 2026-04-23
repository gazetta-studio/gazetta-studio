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
      })
      // 204 No Content — standard REST for successful delete with no body.
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

    try {
      const result = await ingestAsset({
        storage: source.storage,
        assetsRoot: ASSETS_ROOT,
        bytes: file.stream(),
        requestedName: name,
        alt,
        uploadedBy: '',
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
