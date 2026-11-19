import { z } from 'zod'
import { html, type TemplateFunction } from 'gazetta'

export const schema = z.object({})

const template: TemplateFunction = ({ children = [] }) => ({
  html: html`<div class="feature-grid">${children}</div>`,
  css: `.feature-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1.5rem; align-items: stretch; }
.feature-grid > * { display: flex; }
${children.map(c => c.css).join('\n')}`,
  js: children
    .map(c => c.js)
    .filter(Boolean)
    .join('\n'),
})

export default template
