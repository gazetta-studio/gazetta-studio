import { z } from 'zod'
import { html, type TemplateFunction } from 'gazetta'

export const schema = z.object({
  title: z.string().describe('List title'),
  links: z
    .array(
      z.object({
        label: z.string(),
        href: z.string(),
      }),
    )
    .describe('Links'),
})

const template: TemplateFunction = ({ content = {} }) => {
  const links = (content.links ?? []) as Array<{ label: string; href: string }>
  return {
    html: html`<div class="link-list">
  <h4>${content.title ?? ''}</h4>
  ${links.map(l => html`<a href="${l.href}">${l.label}</a>`)}
</div>`,
    css: `.link-list h4 { font-size: 0.8125rem; font-weight: 600; color: #a1a1aa; margin-bottom: 0.75rem; }
.link-list a { display: block; color: #71717a; font-size: 0.8125rem; margin-bottom: 0.375rem; }
.link-list a:hover { color: #d4d4d8; }`,
    js: '',
  }
}

export default template
