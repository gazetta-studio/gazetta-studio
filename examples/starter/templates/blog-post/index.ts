import { z } from 'zod'
import { format, html, raw, type TemplateFunction } from 'gazetta'

export const schema = z.object({
  title: z.string().describe('Post title'),
  date: z.string().optional().describe('Publication date'),
  author: z.string().optional().describe('Author name'),
  tags: z.array(z.string()).optional().describe('Tags'),
  body: z.string().meta(format.markdown()).describe('Post body (markdown)'),
})

type Content = z.infer<typeof schema>

const template: TemplateFunction<Content> = ({ content }) => {
  const tags = content?.tags ?? []
  return {
    html: html`<article class="blog-post">
  <header class="blog-post-header">
    <h1 class="blog-post-title">${content?.title ?? ''}</h1>
    <div class="blog-post-meta">
      ${content?.author ? html`<span class="blog-post-author">By ${content.author}</span>` : ''}
      ${content?.date ? html`<time class="blog-post-date">${content.date}</time>` : ''}
    </div>
    ${tags.length ? html`<div class="blog-post-tags">${tags.map(t => html`<span class="blog-post-tag">${t}</span>`)}</div>` : ''}
  </header>
  <div class="blog-post-body">${raw(content?.body)}</div>
</article>`,
    css: `.blog-post { max-width: 42rem; margin: 0 auto; padding: 2rem 0; }
.blog-post-header { margin-bottom: 2rem; }
.blog-post-title { font-size: 2.25rem; font-weight: 700; line-height: 1.2; margin-bottom: 0.75rem; }
.blog-post-meta { display: flex; gap: 1rem; font-size: 0.875rem; color: #6b7280; margin-bottom: 0.75rem; }
.blog-post-author { font-weight: 500; }
.blog-post-tags { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.blog-post-tag { padding: 0.25rem 0.75rem; background: #f3f4f6; border-radius: 999px; font-size: 0.75rem; color: #4b5563; }
.blog-post-body { line-height: 1.8; }
.blog-post-body h2 { font-size: 1.5rem; margin-top: 2rem; margin-bottom: 0.5rem; }
.blog-post-body h3 { font-size: 1.25rem; margin-top: 1.5rem; margin-bottom: 0.5rem; }
.blog-post-body p { margin-bottom: 1rem; }
.blog-post-body a { color: #667eea; }
.blog-post-body code { background: #f0f0f0; padding: 0.125rem 0.375rem; border-radius: 3px; font-size: 0.875rem; }
.blog-post-body pre { background: #1e1e2e; color: #e0e0e0; padding: 1rem; border-radius: 8px; overflow-x: auto; margin-bottom: 1rem; }
.blog-post-body pre code { background: none; padding: 0; }
.blog-post-body blockquote { border-left: 3px solid #667eea; padding-left: 1rem; color: #666; margin-bottom: 1rem; }
.blog-post-body ul, .blog-post-body ol { margin-bottom: 1rem; padding-left: 1.5rem; }
.blog-post-body img { max-width: 100%; border-radius: 8px; }`,
    js: '',
  }
}

export default template
