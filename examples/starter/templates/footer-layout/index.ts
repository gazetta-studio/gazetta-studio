import { z } from 'zod'
import { html, type TemplateFunction } from 'gazetta'

export const schema = z.object({})

const template: TemplateFunction = ({ children = [] }) => ({
  html: html`<footer class="site-footer">${children}</footer>`,
  css: `.site-footer { padding: 2rem; text-align: center; background: #f5f5f5; border-top: 1px solid #eee; margin-top: auto; }
${children.map(c => c.css).join('\n')}`,
  js: children
    .map(c => c.js)
    .filter(Boolean)
    .join('\n'),
})

export default template
