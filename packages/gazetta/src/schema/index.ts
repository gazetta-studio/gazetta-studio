/**
 * Public schema API — Zod helpers for asset references, reference/resolved
 * types, and the `Content<T>` type mapper templates use to convert their
 * Zod-inferred content type into what the resolver delivers at render time.
 *
 * Usage:
 *
 * ```ts
 * import type { TemplateFunction } from 'gazetta'
 * import { z } from 'zod'
 * import { embeddedAsset, type Content } from 'gazetta/schema'
 *
 * export const schema = z.object({
 *   hero: embeddedAsset({ accept: ['image'] }),
 *   title: z.string(),
 * })
 *
 * const render: TemplateFunction<Content<z.infer<typeof schema>>> = ({ content }) => ({
 *   html: `<img src="${content.hero.url}" alt="${content.hero.alt}"><h1>${content.title}</h1>`,
 *   css: '', js: '',
 * })
 * ```
 */
export { downloadable, embeddedAsset, fontAsset } from './helpers.js'
export type {
  AcceptFilter,
  DownloadableOptions,
  EmbeddedAssetOptions,
  FontAssetOptions,
} from './helpers.js'
export type {
  Content,
  DownloadableAssetRef,
  EmbeddedAssetRef,
  FontAssetRef,
  ResolvedDownloadableAsset,
  ResolvedEmbeddedAsset,
  ResolvedFontAsset,
} from './types.js'
