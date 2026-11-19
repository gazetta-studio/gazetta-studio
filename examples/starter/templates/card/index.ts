import { z } from 'zod'
import { html, type TemplateFunction } from 'gazetta'

export const schema = z.object({
  title: z.string().describe('Card title'),
  body: z.string().describe('Card body text'),
  link: z.string().optional().describe('Link URL'),
  linkText: z.string().optional().describe('Link text'),
})

type Content = z.infer<typeof schema>

const template: TemplateFunction<Content> = ({ content }) => ({
  html: html`<div class="card">
  <h3 class="card-title">${content?.title ?? ''}</h3>
  <p class="card-body">${content?.body ?? ''}</p>
  ${content?.link ? html`<a class="card-link" href="${content.link}">${content.linkText ?? 'Read more'}</a>` : ''}
</div>`,
  css: `.card { padding: 1.5rem; border: 1px solid #e5e7eb; border-radius: 8px; background: #fff; }
.card-title { font-size: 1.125rem; font-weight: 600; margin-bottom: 0.5rem; }
.card-body { color: #6b7280; font-size: 0.875rem; line-height: 1.6; margin-bottom: 0.75rem; }
.card-link { color: #667eea; font-size: 0.875rem; font-weight: 500; text-decoration: none; }
.card-link:hover { text-decoration: underline; }`,
  js: '',
})

export default template
