/**
 * TransformAdapter — delivery strategy for asset bytes.
 *
 * Per Q8 lock, an adapter owns three coupled concerns:
 *   1. URL composition for the primary asset URL and srcset (where
 *      different from the origin's pre-generated ladder)
 *   2. Cache policy for the URLs it produces (since cache semantics
 *      depend on whether bytes are origin-served vs CDN-served)
 *   3. Optional server-side route mounting for adapters that mediate
 *      delivery (e.g. proxy adapters that route through our origin)
 *
 * # Why all three on one interface
 *
 * URL + cache + delivery are coupled. The hardcoded
 * `Cache-Control: immutable` in the serve-route was correct for the
 * sharp adapter but wrong for any adapter that signs URLs with a
 * short-TTL HMAC (future imgproxy) or routes through a CDN with its
 * own cache (cloudflare). Co-locating the policy with the URL builder
 * keeps the contract honest.
 *
 * # Why mountRoutes is optional
 *
 * Origin-passthrough (sharp) and CDN adapters (cloudflare) don't need
 * server-side routes — the existing `assets/serve-route.ts` handles
 * origin bytes; the CDN handles its own. Future proxy adapters
 * (imgproxy, signed-URL workers) would implement `mountRoutes` to
 * add their own handlers.
 *
 * # Why required (not optional) in the resolver context
 *
 * Adapter is always present. Resolver code paths don't branch on
 * "does an adapter exist" — the factory at boot constructs one
 * (defaulting to `sharpAdapter`), and every URL goes through it.
 * Eliminates the conditional URL construction throughout the resolver.
 */
import type { Hono } from 'hono'
import type { Selector } from '../schema/dimensions.js'
import type { AssetVariant } from '../schema/types.js'

/**
 * Input for adapter URL builders. Carries everything an adapter could
 * possibly need; concrete adapters pick what they use. The sharp
 * adapter reads `variants` for srcset; the cloudflare adapter reads
 * `width`/`height` to skip upscaling but ignores `variants`.
 */
export interface AssetUrlInput {
  /** Asset name (the canonical identifier). */
  name: string
  /** 8-char SHA-256 prefix of the bytes. For locale-bytes overrides this is the override's hash. */
  hash: string
  /** File extension without the dot (e.g., 'jpg'). */
  ext: string
  /** Selector identifying which override these bytes are (null = default). */
  selector: Selector | null
  /** Optional site URL — absolute prefix for cross-origin delivery. */
  siteUrl?: string
  /** Pre-generated variants from the manifest. Adapters that ignore this (cloudflare) don't read it. */
  variants: readonly AssetVariant[]
  /** Source width in pixels. Null for non-images. */
  width: number | null
  /** Source height in pixels. Null for non-images. */
  height: number | null
}

/**
 * Cache headers an adapter dictates for the URLs it produced. The
 * asset-serve route applies these when serving origin bytes; CDN
 * adapters return the same policy for documentation (the CDN owns
 * actual caching, but the origin response still carries headers
 * because the CDN re-emits or honors them depending on config).
 */
export interface CachePolicy {
  /** `Cache-Control` header value. */
  cacheControl: string
  /** Optional `Vary` header (theme/locale-aware delivery, format negotiation). */
  vary?: string
}

/**
 * Delivery strategy for asset bytes. Per-target — wired into the
 * resolver context at boot via the `transforms` factory.
 */
export interface TransformAdapter {
  /** Stable identifier — used in telemetry, logs, and adapter selection. */
  readonly name: string

  /**
   * Build the primary URL for an asset's bytes-of-record. This is the
   * URL that goes into `<img src>`, `<a href>`, or `@font-face src`.
   */
  primaryUrl(input: AssetUrlInput): string

  /**
   * Build a `srcset` string for responsive image delivery, OR return
   * null when responsive delivery isn't supported (non-image assets,
   * or images with no variant ladder).
   *
   * Adapter decides ladder semantics:
   *   - sharp adapter reads `input.variants` (pre-generated at upload)
   *   - cloudflare adapter generates ladder from a width set the
   *     adapter chooses (typically 400/800/1200/1600)
   */
  srcset(input: AssetUrlInput): string | null

  /**
   * Cache policy for a URL this adapter produced. Returned headers
   * are applied by whichever serving layer handles the URL — origin
   * route for origin-served adapters, propagated to CDN config for
   * upstream adapters.
   */
  cachePolicy(input: AssetUrlInput): CachePolicy

  /**
   * Mount adapter-specific server-side routes. Called once per app
   * construction by the bootstrap. Origin-passthrough adapters
   * (sharp) and pure CDN adapters (cloudflare) leave this undefined;
   * mediating adapters (future imgproxy, signed URL workers)
   * implement it.
   */
  mountRoutes?(app: Hono): void
}
