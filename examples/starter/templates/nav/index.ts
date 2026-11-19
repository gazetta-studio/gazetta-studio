import { z } from 'zod'
import { html, type TemplateFunction } from 'gazetta'

export const schema = z.object({
  links: z
    .array(
      z.object({
        label: z.string().describe('Link text'),
        href: z.string().describe('URL'),
      }),
    )
    .describe('Navigation links'),
})

const template: TemplateFunction = ({ content = {} }) => {
  const links = (content.links ?? []) as Array<{ label: string; href: string }>
  return {
    html: html`<nav class="site-nav">${links.map(l => html`<a href="${l.href}">${l.label}</a>`)}</nav>`,
    css: `.site-nav { display: flex; gap: 1.5rem; }
.site-nav a { text-decoration: none; color: #333; font-weight: 500; }
.site-nav a:hover { color: #667eea; }`,
    js: '',
  }
}

export default template
