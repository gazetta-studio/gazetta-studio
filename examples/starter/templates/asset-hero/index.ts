/**
 * Asset-hero template — demonstrates the `embeddedAsset()` schema helper.
 *
 * The `image` field is declared via `embeddedAsset()`, which brands the
 * schema with `'embedded'`. At render time, the resolver walks the content,
 * finds the `{ _asset: "..." }` reference, and replaces it with a
 * `ResolvedEmbeddedAsset` that the template consumes via `Content<T>`.
 */
import type { TemplateFunction } from 'gazetta'
import { embeddedAsset, type Content } from 'gazetta/schema'
import { z } from 'zod'

export const schema = z.object({
  image: embeddedAsset({ accept: ['image'] }).describe('Hero image'),
  headline: z.string().describe('Heading text'),
  subheadline: z.string().optional().describe('Supporting text'),
})

type Raw = z.infer<typeof schema>
type Resolved = Content<Raw>

const template: TemplateFunction<Resolved> = ({ content }) => {
  const image = content?.image
  const headline = content?.headline ?? ''
  const subheadline = content?.subheadline ?? ''
  if (!image) {
    return {
      html: `<section class="asset-hero"><h1>${headline}</h1></section>`,
      css: '',
      js: '',
    }
  }
  return {
    html: `<section class="asset-hero">
  <img
    src="${image.url}"
    ${image.srcset ? `srcset="${image.srcset}" sizes="(max-width: 72rem) 100vw, 72rem"` : ''}
    alt="${image.alt}"
    ${image.width ? `width="${image.width}"` : ''}
    ${image.height ? `height="${image.height}"` : ''}
    loading="lazy"
    decoding="async"
  />
  <div class="asset-hero-text">
    <h1>${headline}</h1>
    ${subheadline ? `<p>${subheadline}</p>` : ''}
  </div>
</section>`,
    css: `.asset-hero { position: relative; max-width: 72rem; margin: 2rem auto; border-radius: 12px; overflow: hidden; }
.asset-hero img { width: 100%; height: auto; display: block; }
.asset-hero-text { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; align-items: center; color: #fff; text-shadow: 0 2px 8px rgba(0,0,0,0.6); text-align: center; padding: 2rem; }
.asset-hero-text h1 { font-size: 2.5rem; margin: 0 0 0.75rem; font-weight: 700; }
.asset-hero-text p { font-size: 1.125rem; opacity: 0.95; margin: 0; max-width: 36rem; }`,
    js: '',
  }
}

export default template
