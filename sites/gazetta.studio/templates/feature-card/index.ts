import { z } from 'zod'
import { html, type TemplateFunction } from 'gazetta'

export const schema = z.object({
  icon: z.string().describe('Emoji or icon'),
  title: z.string().describe('Card title'),
  description: z.string().describe('Card description'),
})

const template: TemplateFunction = ({ content = {} }) => ({
  html: html`<div class="fcard">
  <span class="fcard-icon">${content.icon ?? ''}</span>
  <h3>${content.title ?? ''}</h3>
  <p>${content.description ?? ''}</p>
</div>`,
  css: `.fcard { padding: 1.5rem; background: #18181b; border: 1px solid #27272a; border-radius: 12px; height: 100%; display: flex; flex-direction: column; }
.fcard-icon { font-size: 1.5rem; display: block; margin-bottom: 0.75rem; }
.fcard h3 { font-size: 1rem; font-weight: 600; color: #e4e4e7; margin-bottom: 0.5rem; }
.fcard p { font-size: 0.875rem; color: #71717a; line-height: 1.6; }`,
  js: '',
})

export default template
