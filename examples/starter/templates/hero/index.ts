import { z } from 'zod'
import { html, type TemplateFunction } from 'gazetta'

export const schema = z.object({
  title: z.string().describe('Title'),
  subtitle: z.string().optional().describe('Subtitle'),
})

const template: TemplateFunction = ({ content = {} }) => ({
  html: html`<section class="hero">
  <h1>${content.title ?? ''}</h1>
  <p>${content.subtitle ?? ''}</p>
</section>`,
  css: `.hero { padding: 4rem 2rem; text-align: center; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; }
.hero h1 { font-size: 2.5rem; margin-bottom: 1rem; }
.hero p { font-size: 1.25rem; opacity: 0.9; }`,
  js: '',
})

export default template
