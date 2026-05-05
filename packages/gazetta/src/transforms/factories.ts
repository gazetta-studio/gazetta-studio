import type { TransformAdapter } from './adapter.js'
import { createCloudflareAdapter, type CloudflareAdapterOptions } from './cloudflare.js'
import { createSharpAdapter, type SharpAdapterOptions } from './sharp.js'

/**
 * Operator-facing transform adapter factories. Operators import these
 * into `site.config.ts` and call them inline at the `transforms:` field;
 * the field's value IS the constructed `TransformAdapter` instance
 * (Path X — see `design-provider-config.md`).
 */

/** Default sharp-based adapter: origin bytes + pre-generated variant ladder. */
export function sharpAdapter(opts: SharpAdapterOptions = {}): TransformAdapter {
  return createSharpAdapter(opts)
}

/** Cloudflare CDN adapter: routes URLs through `/cdn-cgi/image/` on the
 *  given zone for on-the-fly transforms (format=auto, width ladder). */
export function cloudflareAdapter(opts: CloudflareAdapterOptions): TransformAdapter {
  return createCloudflareAdapter(opts)
}

export type { SharpAdapterOptions, CloudflareAdapterOptions }
