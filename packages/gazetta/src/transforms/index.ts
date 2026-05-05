/**
 * Transform-adapter factory.
 *
 * One switch over `target.transforms?.adapter`, the only place that
 * knows adapter names. Adding a new adapter is one new module + one
 * case here — no edits to resolver, walker, kind resolvers, or
 * serve-route.
 *
 * Default (no `transforms` config) = `sharpAdapter`. This matches the
 * pre-step-18 hardcoded behavior — sites that don't opt into a CDN
 * adapter get the same URLs and cache headers they had before.
 */
import type { TargetConfig } from '../types.js'
import type { TransformAdapter } from './adapter.js'
import { sharpAdapter } from './sharp.js'
import { createCloudflareAdapter } from './cloudflare.js'

/**
 * Construct a `TransformAdapter` from a target's config. Throws on
 * unknown adapter names so misconfiguration surfaces at boot, not
 * silently at render time.
 */
export function buildTransformAdapter(target: TargetConfig): TransformAdapter {
  const config = target.transforms
  if (!config || config.adapter === 'sharp') return sharpAdapter
  switch (config.adapter) {
    case 'cloudflare': {
      if (!config.zone) {
        throw new Error('transforms.adapter "cloudflare" requires a `zone` field (e.g. "cdn.example.com")')
      }
      return createCloudflareAdapter({ zone: config.zone })
    }
    default: {
      // Exhaustive check — TypeScript ensures we don't miss a known adapter.
      // Runtime fallthrough is for when site.config.ts carries an adapter name
      // this build doesn't know.
      const unknown = (config as { adapter: string }).adapter
      throw new Error(`Unknown transforms.adapter "${unknown}". Supported: sharp, cloudflare.`)
    }
  }
}

// Re-exports so callers import everything from `gazetta/transforms`.
export type { AssetUrlInput, CachePolicy, TransformAdapter } from './adapter.js'
export { sharpAdapter } from './sharp.js'
export { createCloudflareAdapter, type CloudflareAdapterOptions } from './cloudflare.js'
