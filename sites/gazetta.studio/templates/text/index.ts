import { z } from 'zod'
import { format, html, raw, type TemplateFunction } from 'gazetta'

export const schema = z.object({
  body: z.string().meta(format.richtext()).describe('Text content'),
})

const template: TemplateFunction = ({ content = {} }) => ({
  html: html`<div class="text-content">${raw(content.body)}</div>`,
  css: `.text-content { font-size: 1rem; color: #a1a1aa; line-height: 1.8; max-width: 48rem; }
.text-content p { margin-bottom: 1rem; }
.text-content strong { color: #e4e4e7; }
.text-content code { background: #18181b; padding: 0.125rem 0.375rem; border-radius: 4px; font-size: 0.875rem; }`,
  js: '',
})

export default template
