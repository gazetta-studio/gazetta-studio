import { z } from 'zod'
import { html, type TemplateFunction } from 'gazetta'

export const schema = z.object({
  brand: z.string().describe('Brand name'),
  links: z
    .array(
      z.object({
        label: z.string(),
        href: z.string(),
      }),
    )
    .describe('Navigation links'),
  cta: z.string().optional().describe('CTA button text'),
  ctaHref: z.string().optional().describe('CTA button URL'),
})

const template: TemplateFunction = ({ content = {} }) => {
  const links = (content.links ?? []) as Array<{ label: string; href: string }>
  return {
    html: html`<nav class="navbar">
  <a href="/" class="navbar-brand">${content.brand ?? ''}</a>
  <div class="navbar-links">
    ${links.map(l => html`<a href="${l.href}">${l.label}</a>`)}
    ${content.cta ? html`<a href="${content.ctaHref ?? '#'}" class="navbar-cta">${content.cta}</a>` : ''}
  </div>
</nav>`,
    css: `.navbar { display: flex; align-items: center; justify-content: space-between; padding: 1rem 2rem; max-width: 72rem; margin: 0 auto; width: 100%; }
.navbar-brand { font-weight: 700; font-size: 1.125rem; color: #fff; }
.navbar-links { display: flex; align-items: center; gap: 1.5rem; }
.navbar-links a { color: #a1a1aa; font-size: 0.875rem; }
.navbar-links a:hover { color: #fff; }
.navbar-cta { padding: 0.375rem 1rem; background: #27272a; border-radius: 6px; color: #e4e4e7 !important; font-weight: 500; }
.navbar-cta:hover { background: #3f3f46; }`,
    js: '',
  }
}

export default template
