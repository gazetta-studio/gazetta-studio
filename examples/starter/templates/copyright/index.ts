import { z } from 'zod'
import { html, type TemplateFunction } from 'gazetta'

export const schema = z.object({
  text: z.string().describe('Copyright text'),
})

const template: TemplateFunction = ({ content = {} }) => ({
  html: html`<p class="copyright">${content.text ?? ''}</p>`,
  css: `.copyright { color: #888; font-size: 0.875rem; }`,
  js: '',
})

export default template
