/**
 * Asset resolution — turn references stored in content JSON into the resolved
 * shapes templates receive at render time.
 *
 * Two public functions:
 * - `resolveEmbeddedRef(ref, ctx)` — resolve a single embedded asset reference
 * - `resolveAssetRefs(content, ctx)` — walk a content object, resolve every
 *   asset reference in place, return the resolved content
 *
 * Separation from `manifest.ts`:
 * - manifest.ts owns manifest I/O (read/write JSON)
 * - this module owns the merge-manifest-with-reference-overrides logic and
 *   the URL construction call
 *
 * The walker (`resolveAssetRefs`) uses a structural check — it recognizes an
 * asset reference by the presence of the `_asset` string field. This means
 * templates can use asset references without wiring special schema metadata;
 * Zod schemas built with `embeddedAsset()` carry the brand for type
 * inference, but at runtime the walker only needs to see `_asset`.
 *
 * Graceful degradation: when a referenced asset can't be resolved (manifest
 * missing, corrupt, or storage failure), the walker returns a placeholder
 * resolved shape and logs the error. Pages continue rendering; authors see
 * degraded output instead of crashed pages (design-media.md §Template
 * contract → Graceful degradation).
 */
import type { ResolvedEmbeddedAsset } from '../schema/types.js'
import type { StorageProvider } from '../types.js'
import { AssetManifestCorruptError, AssetManifestNotFoundError } from './errors.js'
import { readManifest } from './manifest.js'
import { buildAssetUrl, extFromMime } from './url.js'

/** Context needed to resolve a reference — shared across all refs in a render pass. */
export interface AssetResolveContext {
  /** The source target's storage provider (where manifests + bytes live). */
  storage: StorageProvider
  /** Path prefix for assets within the storage root (typically `"assets"`). */
  assetsRoot: string
  /**
   * Site URL prefix for absolute URLs. When absent, URLs are root-relative.
   * Used for targets served from a separate origin.
   */
  siteUrl?: string
}

/** Shape of an embedded-asset reference as stored in content JSON. */
interface EmbeddedRefShape {
  _asset: string
  alt?: string
  focalPoint?: { x: number; y: number }
}

/**
 * Resolve a single embedded-asset reference. Reads the manifest, merges
 * per-reference overrides, returns a `ResolvedEmbeddedAsset`.
 *
 * Throws on manifest not-found or corrupt — callers that want graceful
 * degradation (e.g., `resolveAssetRefs`) catch and substitute a placeholder.
 */
export async function resolveEmbeddedRef(
  ref: EmbeddedRefShape,
  ctx: AssetResolveContext,
): Promise<ResolvedEmbeddedAsset> {
  const manifest = await readManifest(ctx.storage, ctx.assetsRoot, ref._asset)

  const ext = extFromMime(manifest.mime)
  if (!ext) {
    // Should never happen for v1's allowlist (JPEG, PNG), but the extension
    // derivation is defensive — a manifest with an unknown MIME is a bug.
    throw new AssetManifestCorruptError(
      `${ctx.assetsRoot}/${ref._asset}.asset.json`,
      new Error(`No extension known for MIME ${manifest.mime}`),
    )
  }

  const url = buildAssetUrl({
    name: manifest.name,
    hash: manifest.hash,
    ext,
    siteUrl: ctx.siteUrl,
  })

  // Merge: per-ref override wins; manifest's alt is the fallback.
  // `null` alt on the manifest + no override = empty string (decorative).
  const alt = ref.alt ?? manifest.alt ?? ''

  return {
    url,
    srcset: null, // Variants arrive in a later step — for now, single URL only.
    width: manifest.width,
    height: manifest.height,
    duration: null,
    animated: false,
    poster: null,
    alt,
    focalPoint: ref.focalPoint ?? null,
    mime: manifest.mime,
  }
}

/** Placeholder returned when a reference can't be resolved. */
const PLACEHOLDER: ResolvedEmbeddedAsset = {
  url: '/assets/__missing__.svg',
  srcset: null,
  width: null,
  height: null,
  duration: null,
  animated: false,
  poster: null,
  alt: '',
  focalPoint: null,
  mime: 'image/svg+xml',
}

/** Structural check — is this value an embedded asset reference? */
function isEmbeddedRef(value: unknown): value is EmbeddedRefShape {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return typeof v._asset === 'string'
}

/**
 * Walk a content object and resolve every asset reference found. Returns a
 * new content object with references swapped for resolved shapes; arrays and
 * nested objects are recursed into. Non-ref values are copied unchanged.
 *
 * Graceful degradation: references that fail to resolve are replaced with a
 * placeholder. Errors are logged but don't halt rendering.
 */
export async function resolveAssetRefs(
  content: Record<string, unknown> | undefined,
  ctx: AssetResolveContext,
): Promise<Record<string, unknown> | undefined> {
  if (!content) return content
  return (await walk(content, ctx)) as Record<string, unknown>
}

async function walk(value: unknown, ctx: AssetResolveContext): Promise<unknown> {
  if (isEmbeddedRef(value)) {
    try {
      return await resolveEmbeddedRef(value, ctx)
    } catch (err) {
      if (err instanceof AssetManifestNotFoundError || err instanceof AssetManifestCorruptError) {
        // eslint-disable-next-line no-console
        console.warn(`[asset-resolver] ${err.message}`)
        return PLACEHOLDER
      }
      throw err
    }
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map(item => walk(item, ctx)))
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      result[key] = await walk(v, ctx)
    }
    return result
  }
  return value
}
