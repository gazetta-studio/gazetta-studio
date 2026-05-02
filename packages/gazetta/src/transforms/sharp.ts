/**
 * Default `TransformAdapter`: origin bytes + pre-generated variant ladder.
 *
 * Bytes are served from the target's storage via `assets/serve-route.ts`.
 * Variants are pre-generated at upload by sharp (see `assets/variants.ts`)
 * and listed in the manifest's `variants` array. Both URLs and srcset
 * descriptors point at origin paths — the CDN, if any, caches as-is.
 *
 * Cache policy: `public, max-age=31536000, immutable`. Safe because
 * hash-in-path is content-addressed — new bytes mean a new URL, so
 * the URL's response is genuinely immutable.
 *
 * Single responsibility: wrap `buildAssetUrl` + `buildSrcset` from
 * `assets/url.ts` behind the `TransformAdapter` interface. No extra
 * logic — the adapter is the right shape for swap-out, and the URL
 * helpers stay reusable for tests and future adapters that compose
 * origin URLs (cloudflare prefixes them; imgproxy wraps them).
 */
import { buildAssetUrl, buildSrcset } from '../assets/url.js'
import type { AssetUrlInput, CachePolicy, TransformAdapter } from './adapter.js'

const IMMUTABLE_CACHE: CachePolicy = {
  cacheControl: 'public, max-age=31536000, immutable',
}

export const sharpAdapter: TransformAdapter = {
  name: 'sharp',

  primaryUrl(input: AssetUrlInput): string {
    return buildAssetUrl({
      name: input.name,
      hash: input.hash,
      ext: input.ext,
      siteUrl: input.siteUrl,
      selector: input.selector,
    })
  },

  srcset(input: AssetUrlInput): string | null {
    if (input.variants.length === 0) return null
    return buildSrcset(input.variants, input.siteUrl)
  },

  cachePolicy(_input: AssetUrlInput): CachePolicy {
    return IMMUTABLE_CACHE
  },
}
