/**
 * HTTP route: `POST /api/assets` — upload an asset.
 *
 * Thin adapter. Parses multipart form data, resolves the active target's
 * storage, delegates to `ingestAsset`, maps typed errors to HTTP responses.
 * No validation logic, no storage logic, no manifest construction in here —
 * the asset domain owns all of that (see `src/assets/`).
 *
 * Multipart fields:
 * - `file` — required, the byte payload
 * - `name` — required, author-chosen asset name (pre-validation)
 * - `alt`  — optional, alt text (empty string = "decorative"; absent = "not set")
 */
import { Hono } from 'hono'
import { deleteAsset } from '../../assets/delete.js'
import { ingestAsset } from '../../assets/ingest.js'
import { listAssets, toSummary } from '../../assets/list.js'
import { readManifest } from '../../assets/manifest.js'
import {
  AssetInUseError,
  AssetManifestCorruptError,
  AssetManifestNotFoundError,
  AssetProviderNotCapableError,
  AssetStorageError,
  AssetValidationError,
} from '../../assets/errors.js'
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
      if (err instanceof AssetStorageError) {
        return c.json({ code: err.code, message: err.message }, 500)
      }
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
      if (err instanceof AssetManifestNotFoundError) {
        return c.json({ code: err.code, message: err.message }, 404)
      }
      if (err instanceof AssetManifestCorruptError) {
        return c.json({ code: err.code, message: err.message }, 500)
      }
      if (err instanceof AssetStorageError) {
        return c.json({ code: err.code, message: err.message }, 500)
      }
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
      if (err instanceof AssetManifestNotFoundError) {
        return c.json({ code: err.code, message: err.message }, 404)
      }
      if (err instanceof AssetInUseError) {
        // 409 Conflict — request cannot complete because of the server's
        // current state (refs still exist). Body includes the usage list so
        // the admin can render the refuse dialog without a second fetch.
        return c.json(
          {
            code: err.code,
            message: err.message,
            assetName: err.assetName,
            refs: err.refs,
          },
          409,
        )
      }
      if (err instanceof AssetStorageError) {
        return c.json({ code: err.code, message: err.message }, 500)
      }
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
      if (err instanceof AssetValidationError) {
        return c.json({ code: err.code, message: err.message }, 400)
      }
      if (err instanceof AssetProviderNotCapableError) {
        return c.json({ code: err.code, message: err.message }, 501)
      }
      if (err instanceof AssetStorageError) {
        return c.json({ code: err.code, message: err.message }, 500)
      }
      throw err
    }
  })

  return app
}
