/**
 * HTTP route: `GET /assets/*` — serve asset bytes from a storage provider.
 *
 * Thin adapter. Opens a `readStream` and pipes it to the response with
 * Content-Type, cache, ETag, Content-Disposition, and CORS headers per
 * the design-media.md "Asset serving" contract. Range request support
 * lets `<video>` seek and `<audio>` resume; a matching `If-None-Match`
 * short-circuits to 304 before any bytes are read.
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
 * - `X-Content-Type-Options: nosniff` + `Content-Disposition`
 *   (`attachment` for non-embedded kinds) keep document uploads from
 *   rendering inline in the asset origin.
 * - `Access-Control-Allow-Origin: *` — assets are public in v1.
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
    const urlInput = parseAssetUrlInput(path, ext)
    const policy = adapter.cachePolicy(urlInput)

    // Content-addressed ETag: the 8-hex hash in the filename IS the
    // validator. A filename without a hash suffix yields no ETag and
    // no conditional handling (rather than an empty-quoted-string tag).
    const etag = urlInput.hash ? `"${urlInput.hash}"` : undefined

    if (etag && ifNoneMatches(c.req.header('if-none-match'), etag)) {
      c.header('ETag', etag)
      c.header('Cache-Control', policy.cacheControl)
      if (policy.vary) c.header('Vary', policy.vary)
      return c.body(null, 304)
    }

    try {
      const bodyStream = await storage.readStream(storagePath, range)
      c.header('Content-Type', mime)
      c.header('X-Content-Type-Options', 'nosniff')
      c.header('Cache-Control', policy.cacheControl)
      if (policy.vary) c.header('Vary', policy.vary)
      if (etag) c.header('ETag', etag)
      c.header('Content-Disposition', dispositionFor(mime))
      c.header('Access-Control-Allow-Origin', '*')
      // Advertise range support on every response so `<video>`/`<audio>`
      // clients know they can seek (RFC 9110 §14.3).
      c.header('Accept-Ranges', 'bytes')
      if (range) {
        // A satisfied range MUST be a 206 with Content-Range (RFC 9110
        // §14.4). complete-length is reported as `*` because the
        // StorageProvider contract exposes no file size; the byte
        // positions come from the (satisfied) request range.
        c.header('Content-Range', `bytes ${range.start}-${range.end}/*`)
        c.status(206)
      }
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

/**
 * Parse a byte-range HTTP header into the storage provider's `ByteRange`.
 *
 * Returns a finite, satisfiable range only. Open-ended `bytes=N-` returns
 * `undefined` so the caller ignores the Range and serves a full 200
 * response (permitted by RFC 9110 §14.2). Honoring `bytes=N-` as a real
 * 206 would require the last-byte position (`size-1`), and the
 * `StorageProvider` contract exposes no file size — resolving it is a
 * cross-cutting addition tracked separately. The caller still advertises
 * `Accept-Ranges: bytes`, so a client wanting a partial re-requests with
 * a finite range.
 */
function parseRange(header: string | undefined): { start: number; end: number } | undefined {
  if (!header) return undefined
  const match = /^bytes=(\d+)-(\d+)?$/.exec(header)
  if (!match) return undefined
  const start = Number.parseInt(match[1], 10)
  if (!match[2]) return undefined
  const end = Number.parseInt(match[2], 10)
  return { start, end }
}

/**
 * Evaluate `If-None-Match` against the asset's ETag. RFC 7232 §3.2
 * mandates *weak comparison* for `If-None-Match`: a weak validator
 * (`W/"tag"`) matches the strong form (`"tag"`) of the same opaque-tag.
 * Strip the `W/` prefix from both the request token and the ETag before
 * comparing, so a client or proxy sending the weak form still gets the
 * 304. `*` matches any representation — the asset exists (`storage.exists`
 * already passed), so it short-circuits to a match.
 */
function ifNoneMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false
  if (header.trim() === '*') return true
  const want = stripWeakPrefix(etag)
  return header.split(',').some(token => stripWeakPrefix(token.trim()) === want)
}

function stripWeakPrefix(tag: string): string {
  return tag.startsWith('W/') ? tag.slice(2) : tag
}

/**
 * `Content-Disposition` per the asset's rendering contract. Embedded
 * kinds (image/video/audio, rendered inline by templates) serve
 * `inline`; everything else serves `attachment` so documents download
 * rather than render in the asset origin. v1 infers the kind from the
 * response MIME — reading the manifest's `kind` field is the
 * authoritative upgrade once non-image MIMEs enter `MIME_BY_EXT`.
 */
function dispositionFor(mime: string): string {
  return /^(?:image|video|audio)\//.test(mime) ? 'inline' : 'attachment'
}
