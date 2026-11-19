import { z } from 'zod'
import { html, type TemplateFunction } from 'gazetta'

export const schema = z.object({
  text: z.string().describe('Logo text'),
  href: z.string().optional().describe('Link URL'),
})

const template: TemplateFunction = ({ content = {} }) => ({
  html: content.href
    ? html`<a class="site-logo" href="${content.href}">${content.text ?? ''}</a>`
    : html`<span class="site-logo">${content.text ?? ''}</span>`,
  css: `.site-logo { font-size: 1.25rem; font-weight: 700; text-decoration: none; color: #1a1a1a; }`,
  js: '',
})

export default template
