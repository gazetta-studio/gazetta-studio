import { z } from 'zod'
import { html, type TemplateFunction } from 'gazetta'

export const schema = z.object({
  title: z.string().describe('Article title'),
  author: z.string().optional().describe('Author name'),
  body: z.string().describe('Article body'),
})

const template: TemplateFunction = ({ content = {}, params = {} }) => ({
  html: html`<article class="article">
  <h1>${content.title ?? params.slug ?? ''}</h1>
  <p class="article-meta">By ${content.author ?? 'Unknown'}</p>
  <div class="article-body">${content.body ?? ''}</div>
</article>`,
  css: `.article { padding: 3rem 2rem; max-width: 48rem; margin: 0 auto; }
.article h1 { font-size: 2rem; margin-bottom: 0.5rem; }
.article-meta { color: #888; margin-bottom: 2rem; }
.article-body { line-height: 1.8; }`,
  js: '',
})

export default template
