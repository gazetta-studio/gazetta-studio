import { z } from 'zod'
import { html, type TemplateFunction } from 'gazetta'

// Layout template — renders children in a <main> wrapper with a CSS
// reset. Has no content of its own (no visible fields for the editor).
//
// SEO tags (<title>, <meta description>, OG, canonical) are handled
// by the renderer's fallback chain from page.metadata / content of
// child components. Templates should NOT emit SEO tags — the renderer
// deduplicates, but the clean pattern is to let the renderer own <head>
// SEO and let templates own visible HTML + non-SEO head (fonts, icons).
export const schema = z.object({})

const template: TemplateFunction = ({ children = [] }) => ({
  html: html`<main>${children}</main>`,
  css: `*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui, -apple-system, sans-serif; color: #1a1a1a; line-height: 1.6; }
main { min-height: 100vh; display: flex; flex-direction: column; }
${children.map(c => c.css).join('\n')}`,
  js: children
    .map(c => c.js)
    .filter(Boolean)
    .join('\n'),
  head: `<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚡</text></svg>">
${children
  .map(c => c.head)
  .filter(Boolean)
  .join('\n')}`,
})

export default template
