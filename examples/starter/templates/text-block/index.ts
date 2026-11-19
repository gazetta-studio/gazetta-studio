import { z } from 'zod'
import { format, html, raw, type TemplateFunction } from 'gazetta'

export const schema = z.object({
  heading: z.string().describe('Heading'),
  body: z.string().meta(format.richtext()).describe('Body text'),
})

const template: TemplateFunction = ({ content = {} }) => ({
  html: html`<section class="text-block">
  <h2>${content.heading ?? ''}</h2>
  <div class="text-block-body">${raw(content.body)}</div>
</section>`,
  css: `.text-block { padding: 3rem 2rem; max-width: 48rem; margin: 0 auto; }
.text-block h2 { font-size: 1.75rem; margin-bottom: 1rem; }
.text-block-body { color: #555; }`,
  js: '',
})

export default template
