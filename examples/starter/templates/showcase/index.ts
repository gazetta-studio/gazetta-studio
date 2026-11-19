import { z } from 'zod'
import { format, html, raw, type TemplateFunction } from 'gazetta'

export const schema = z.object({
  // Rich text (Tiptap editor)
  body: z.string().meta(format.richtext()).describe('Rich text content'),

  // Image with preview
  image: z.string().meta(format.image()).optional().describe('Hero image URL'),

  // Link input
  website: z.string().meta(format.link()).optional().describe('Website URL'),

  // Slug
  slug: z.string().meta(format.slug()).optional().describe('URL slug'),

  // Code editor
  snippet: z
    .string()
    .meta(format.code({ language: 'html' }))
    .optional()
    .describe('HTML snippet'),

  // JSON editor
  metadata: z.string().meta(format.json()).optional().describe('Custom metadata (JSON)'),

  // Color picker (explicit format)
  accentColor: z.string().meta(format.color()).optional().describe('Accent color'),

  // Select (enum)
  layout: z.enum(['centered', 'wide', 'full']).optional().describe('Layout style'),
})

type Content = z.infer<typeof schema>

const template: TemplateFunction<Content> = ({ content }) => {
  const accent = content?.accentColor ?? '#667eea'
  return {
    html: html`<section class="showcase" style="--accent: ${accent}">
  ${content?.image ? html`<img class="showcase-img" src="${content.image}" alt="" />` : ''}
  <div class="showcase-body ${content?.layout ?? 'centered'}">${raw(content?.body)}</div>
  ${content?.website ? html`<a class="showcase-link" href="${content.website}">Visit website</a>` : ''}
  ${content?.snippet ? html`<div class="showcase-snippet">${content.snippet}</div>` : ''}
  ${content?.slug ? html`<div class="showcase-slug">/${content.slug}</div>` : ''}
</section>`,
    css: `.showcase { padding: 2rem; max-width: 72rem; margin: 0 auto; }
.showcase-img { max-width: 100%; border-radius: 8px; margin-bottom: 1.5rem; }
.showcase-body { line-height: 1.7; }
.showcase-body.wide { max-width: 48rem; }
.showcase-body.centered { max-width: 36rem; margin: 0 auto; text-align: center; }
.showcase-body.full { max-width: none; }
.showcase-link { display: inline-block; margin-top: 1rem; color: var(--accent); text-decoration: none; font-weight: 600; }
.showcase-link:hover { text-decoration: underline; }
.showcase-snippet { margin-top: 1.5rem; padding: 1rem; background: #f3f4f6; border-radius: 8px; font-family: monospace; font-size: 0.875rem; white-space: pre-wrap; }
.showcase-slug { margin-top: 0.5rem; color: #9ca3af; font-size: 0.875rem; font-family: monospace; }`,
    js: '',
  }
}

export default template
