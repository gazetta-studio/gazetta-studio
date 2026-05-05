/**
 * Transform-adapter barrel.
 *
 * Path X (per `design-provider-config.md`): operators construct
 * `TransformAdapter` instances via factory calls inline in
 * `site.config.ts`; `target.transforms` IS the constructed adapter.
 * The resolver reads it directly — no factory dispatch in the runtime.
 *
 * Operator-facing factories (`sharpAdapter`, `cloudflareAdapter`) live
 * in `factories.ts` and are re-exported below for the `gazetta/transforms`
 * subpath.
 */
export type { AssetUrlInput, CachePolicy, TransformAdapter } from './adapter.js'

// Internal factories — kept public for tests + advanced wiring.
export { createSharpAdapter, defaultSharpAdapter, type SharpAdapterOptions } from './sharp.js'
export { createCloudflareAdapter, type CloudflareAdapterOptions } from './cloudflare.js'

// Operator-facing factories.
export { sharpAdapter, cloudflareAdapter } from './factories.js'
