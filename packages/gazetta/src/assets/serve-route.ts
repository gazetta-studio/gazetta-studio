/**
 * HTTP route: `GET /assets/*` — serve asset bytes from a storage provider.
 *
 * Thin adapter. Narrows the provider to `BinaryStorage`, opens a `readStream`,
 * pipes it to the response with Content-Type + cache headers. Range request
 * support lets `<video>` seek and `<audio>` resume.
 *
 * Mount this at the top level of the serving app (dev server,
 * `gazetta serve`), NOT under `/admin` — the resolver emits root-relative
 * `/assets/...` URLs that must match this route.
 *
 * The factory takes a **storage resolver** (not a full admin-api
 * SourceContext) because the only thing this route needs is the provider
 * for the active target. Keeping the contract narrow lets the dev server,
 * production `serve`, and future edge-runtime adapters all mount it the
 * same way.
 *
 * Security:
 * - Rejects paths containing `..` (belt-and-suspenders)
 * - `Cache-Control: public, max-age=31536000, immutable` — safe because the
 *   hash is in the URL; new bytes = new URL
 */
import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import { isBinaryCapable, type StorageProvider } from '../types.js'

/** Where assets live, relative to the target storage root. */
const ASSETS_ROOT = 'assets'

/** MIME lookup for extensions we produce in v1 (JPEG, PNG). */
const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
}

/**
 * Resolve the storage provider to serve from, given an optional target
 * query param. Narrower than the admin-api SourceContextResolver — this
 * route only needs storage, not the rest of the source context.
 */
export type AssetStorageResolver = (targetName: string | undefined) => Promise<StorageProvider>

export function assetServeRoutes(resolveStorage: AssetStorageResolver) {
  const app = new Hono()

  app.get('/assets/*', async c => {
    const url = new URL(c.req.url)
    const path = url.pathname.replace(/^\/assets\//, '')

    if (path.includes('..') || path.startsWith('/')) {
      return c.text('Invalid asset path', 400)
    }

    const storage = await resolveStorage(c.req.query('target'))
    if (!isBinaryCapable(storage)) {
      return c.text('Target storage does not support streaming assets', 501)
    }

    const storagePath = `${ASSETS_ROOT}/${path}`
    if (!(await storage.exists(storagePath))) {
      return c.text('Not found', 404)
    }

    const ext = path.split('.').pop()?.toLowerCase() ?? ''
    const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream'

    const range = parseRange(c.req.header('range'))

    try {
      const bodyStream = await storage.readStream(storagePath, range)
      c.header('Content-Type', mime)
      c.header('X-Content-Type-Options', 'nosniff')
      c.header('Cache-Control', 'public, max-age=31536000, immutable')
      return stream(c, async out => {
        await out.pipe(bodyStream)
      })
    } catch {
      return c.text('Error reading asset', 500)
    }
  })

  return app
}

/** Parse a byte-range HTTP header into the storage provider's `ByteRange`. */
function parseRange(header: string | undefined): { start: number; end: number } | undefined {
  if (!header) return undefined
  const match = /^bytes=(\d+)-(\d+)?$/.exec(header)
  if (!match) return undefined
  const start = Number.parseInt(match[1], 10)
  const end = match[2] ? Number.parseInt(match[2], 10) : Number.POSITIVE_INFINITY
  return Number.isFinite(end) ? { start, end } : undefined
}
