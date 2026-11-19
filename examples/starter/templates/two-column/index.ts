import { z } from 'zod'
import { html, type TemplateFunction } from 'gazetta'

export const schema = z.object({
  sidebarWidth: z.string().optional().describe('Sidebar width (default: 280px)'),
  reverse: z.boolean().optional().describe('Put sidebar on the right'),
})

type Content = z.infer<typeof schema>

const template: TemplateFunction<Content> = ({ content, children = [] }) => {
  const sidebar = children[0]
  const main = children.slice(1)
  const width = content?.sidebarWidth ?? '280px'
  const direction = content?.reverse ? 'row-reverse' : 'row'
  return {
    html: html`<div class="two-col" style="flex-direction:${direction}">
  <aside class="two-col-sidebar">${sidebar ?? ''}</aside>
  <div class="two-col-main">${main}</div>
</div>`,
    css: `.two-col { display: flex; gap: 2rem; max-width: 72rem; margin: 0 auto; padding: 2rem; }
.two-col-sidebar { flex: 0 0 ${width}; }
.two-col-main { flex: 1; min-width: 0; }
@media (max-width: 768px) { .two-col { flex-direction: column !important; } .two-col-sidebar { flex: none; } }
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
