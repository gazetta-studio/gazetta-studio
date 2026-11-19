import { createHighlighter, type Highlighter } from 'shiki'
import { z } from 'zod'
import { html, raw, type TemplateFunction } from 'gazetta'

export const schema = z.object({
  code: z.string().describe('Code content'),
  language: z.string().optional().describe('Language label'),
})

type Content = z.infer<typeof schema>

let highlighter: Highlighter | null = null

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighter) {
    highlighter = await createHighlighter({
      themes: ['github-dark'],
      langs: ['typescript', 'tsx', 'bash', 'yaml', 'json'],
    })
  }
  return highlighter
}

const template: TemplateFunction<Content> = async ({ content }) => {
  const { code = '', language } = content ?? {}
  const hl = await getHighlighter()

  const lang =
    language
      ?.toLowerCase()
      .replace('plain typescript', 'typescript')
      .replace('vue 3', 'typescript')
      .replace('react', 'tsx') ?? 'typescript'

  const highlighted = hl.codeToHtml(code, { lang, theme: 'github-dark' })

  return {
    html: html`<div class="code-block">
  ${language ? html`<span class="code-lang">${language}</span>` : ''}
  ${raw(highlighted)}
</div>`,
    css: `.code-block { position: relative; background: #24292e; border: 1px solid #27272a; border-radius: 8px; overflow: hidden; max-width: 40rem; margin: 0 auto; }
.code-lang { position: absolute; top: 0.5rem; right: 0.75rem; font-size: 0.6875rem; color: #52525b; text-transform: uppercase; z-index: 1; }
.code-block pre { padding: 1.25rem; overflow-x: auto; font-size: 0.875rem; line-height: 1.7; margin: 0; }
.code-block code { font-family: 'JetBrains Mono', 'Fira Code', monospace; }
.code-block .shiki { background-color: transparent !important; }`,
    js: '',
  }
}

export default template
