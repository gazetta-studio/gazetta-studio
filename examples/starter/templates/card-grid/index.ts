import { z } from 'zod'
import { html, type TemplateFunction } from 'gazetta'

export const schema = z.object({
  heading: z.string().optional().describe('Section heading'),
  columns: z.number().optional().describe('Minimum column width in px (default: 280)'),
})

type Content = z.infer<typeof schema>

const template: TemplateFunction<Content> = ({ content, children = [] }) => {
  const minWidth = content?.columns ?? 280
  return {
    html: html`<section class="card-grid">
  ${content?.heading ? html`<h2 class="card-grid-heading">${content.heading}</h2>` : ''}
  <div class="card-grid-items">${children}</div>
</section>`,
    css: `.card-grid { padding: 3rem 2rem; max-width: 72rem; margin: 0 auto; }
.card-grid-heading { font-size: 1.75rem; text-align: center; margin-bottom: 2rem; }
.card-grid-items { display: grid; grid-template-columns: repeat(auto-fit, minmax(${minWidth}px, 1fr)); gap: 1.5rem; }
${children.map(c => c.css).join('\n')}`,
    js: children
      .map(c => c.js)
      .filter(Boolean)
      .join('\n'),
    head: children
      .map(c => c.head)
      .filter(Boolean)
      .join('\n'),
  }
}

export default template
