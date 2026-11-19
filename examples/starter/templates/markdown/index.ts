import { z } from 'zod'
import { format, html, raw, type TemplateFunction } from 'gazetta'

export const schema = z.object({
  body: z.string().meta(format.markdown()).describe('Content (markdown)'),
})

type Content = z.infer<typeof schema>

const template: TemplateFunction<Content> = ({ content }) => ({
  html: html`<article class="markdown">${raw(content?.body)}</article>`,
  css: `.markdown { max-width: 42rem; margin: 0 auto; padding: 2rem 0; line-height: 1.8; }
.markdown h1 { font-size: 2rem; margin-bottom: 0.5rem; }
.markdown h2 { font-size: 1.5rem; margin-top: 2rem; margin-bottom: 0.5rem; }
.markdown h3 { font-size: 1.25rem; margin-top: 1.5rem; margin-bottom: 0.5rem; }
.markdown p { margin-bottom: 1rem; }
.markdown a { color: #667eea; }
.markdown code { background: #f0f0f0; padding: 0.125rem 0.375rem; border-radius: 3px; font-size: 0.875rem; }
.markdown pre { background: #1e1e2e; color: #e0e0e0; padding: 1rem; border-radius: 8px; overflow-x: auto; margin-bottom: 1rem; }
.markdown pre code { background: none; padding: 0; }
.markdown blockquote { border-left: 3px solid #667eea; padding-left: 1rem; color: #666; margin-bottom: 1rem; }
.markdown ul, .markdown ol { margin-bottom: 1rem; padding-left: 1.5rem; }
.markdown li { margin-bottom: 0.25rem; }
.markdown table { width: 100%; border-collapse: collapse; margin-bottom: 1rem; }
.markdown th, .markdown td { padding: 0.5rem; border: 1px solid #ddd; text-align: left; }
.markdown th { background: #f8f8f8; font-weight: 600; }
.markdown hr { border: none; border-top: 1px solid #eee; margin: 2rem 0; }
.markdown img { max-width: 100%; border-radius: 8px; }`,
  js: '',
})

export default template
