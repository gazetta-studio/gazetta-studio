/**
 * HTTP route: `GET /assets/*` — serve asset bytes from a storage provider.
 *
 * Thin adapter. Opens a `readStream` and pipes it to the response with
 * Content-Type + cache headers. Range request support lets `<video>`
 * seek and `<audio>` resume.
 *
 * Mount this at the top level of the serving app (dev server,
 * `gazetta serve`), NOT under `/admin` — the resolver emits root-relative
 * `/assets/...` URLs that must match this route.
 *
 * The factory takes a **storage resolver** + an optional **adapter
 * resolver**. Storage gives us the bytes; adapter gives us the cache
 * policy. Without an adapter resolver, the route falls back to the
 * sharp adapter's policy (immutable, the v1 default) — that keeps
 * dev/test flows that don't wire transform config working unchanged.
 *
 * Security:
 * - Rejects paths containing `..` (belt-and-suspenders)
 * - Cache headers come from `adapter.cachePolicy()` — whatever the
 *   adapter says is right for the URLs it produces. Default
 *   (sharp adapter) returns `immutable` because hash-in-path is
 *   content-addressed: new bytes mean a new URL.
 */
import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import type { StorageProvider } from '../types.js'
import type { AssetUrlInput, TransformAdapter } from '../transforms/adapter.js'
import { defaultSharpAdapter } from '../transforms/sharp.js'

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

/**
 * Resolve the transform adapter for the active target. Per-target
 * because adapter config (and thus cache policy) is per-target.
 * Optional — when absent, the route uses the sharp adapter's policy.
 */
export type AssetAdapterResolver = (targetName: string | undefined) => Promise<TransformAdapter>

export interface AssetServeRoutesOptions {
  resolveStorage: AssetStorageResolver
  resolveAdapter?: AssetAdapterResolver
}

export function assetServeRoutes(resolveStorageOrOptions: AssetStorageResolver | AssetServeRoutesOptions): Hono {
  // Accept either the legacy `resolveStorage` callable or an options
  // object. The callable form keeps the pre-step-18 signature working
  // for callers that haven't migrated.
  const opts: AssetServeRoutesOptions =
    typeof resolveStorageOrOptions === 'function'
      ? { resolveStorage: resolveStorageOrOptions }
      : resolveStorageOrOptions

  const app = new Hono()

  app.get('/assets/*', async c => {
    const url = new URL(c.req.url)
    const path = url.pathname.replace(/^\/assets\//, '')

    if (path.includes('..') || path.startsWith('/')) {
      return c.text('Invalid asset path', 400)
    }

    const targetName = c.req.query('target')
    const storage = await opts.resolveStorage(targetName)
    const storagePath = `${ASSETS_ROOT}/${path}`
    if (!(await storage.exists(storagePath))) {
      return c.text('Not found', 404)
    }

    const ext = path.split('.').pop()?.toLowerCase() ?? ''
    const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream'

    const range = parseRange(c.req.header('range'))

    // Cache policy from the adapter. The route only has the URL path,
    // so it constructs a minimal AssetUrlInput — name/hash/ext parsed
    // from the filename. Today's adapters return constant policies
    // regardless of input; future per-input policy adapters will have
    // what they need.
    const adapter = opts.resolveAdapter ? await opts.resolveAdapter(targetName) : defaultSharpAdapter
    const policy = adapter.cachePolicy(parseAssetUrlInput(path, ext))

    try {
      const bodyStream = await storage.readStream(storagePath, range)
      c.header('Content-Type', mime)
      c.header('X-Content-Type-Options', 'nosniff')
      c.header('Cache-Control', policy.cacheControl)
      if (policy.vary) c.header('Vary', policy.vary)
      return stream(c, async out => {
        await out.pipe(bodyStream)
      })
    } catch {
      return c.text('Error reading asset', 500)
    }
  })

  return app
}

/**
 * Parse a minimal `AssetUrlInput` from the URL path. Used only for the
 * `cachePolicy()` call — the route doesn't need to recover full
 * variants/dimensions, just whatever the adapter might key on.
 *
 * Filename shape: `{name}-{hash}[.{loc}][.{theme}][-{w}w].{ext}`. We
 * extract `name` and `hash`; selector/variants/dims default to nulls.
 * Future adapters that need more (e.g. per-locale cache TTL) would
 * expand this parser or we'd thread the resolver-time inputs through
 * a different path.
 */
function parseAssetUrlInput(path: string, ext: string): AssetUrlInput {
  // Strip extension.
  const stem = path.replace(/\.[^.]+$/, '')
  // Match `{name}-{hash}` where hash is 8 hex chars; everything after
  // the first hash-suffix is selector + width.
  const m = /^(.+)-([0-9a-f]{8})/.exec(stem)
  const name = m ? m[1]! : stem
  const hash = m ? m[2]! : ''
  return {
    name,
    hash,
    ext,
    selector: null,
    variants: [],
    width: null,
    height: null,
  }
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
