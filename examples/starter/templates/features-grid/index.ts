import { z } from 'zod'
import { html, type TemplateFunction } from 'gazetta'

export const schema = z.object({
  heading: z.string().describe('Section heading'),
})

const template: TemplateFunction = ({ content = {}, children = [] }) => ({
  html: html`<section class="features">
  <h2>${content.heading ?? ''}</h2>
  <div class="features-grid">${children}</div>
</section>`,
  css: `.features { padding: 3rem 2rem; }
.features h2 { text-align: center; font-size: 1.75rem; margin-bottom: 2rem; }
.features-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1.5rem; max-width: 60rem; margin: 0 auto; }
${children.map(c => c.css).join('\n')}`,
  js: children
    .map(c => c.js)
    .filter(Boolean)
    .join('\n'),
})

export default template
