/**
 * gazetta.studio's templates escape plain text, insert rich-text fields as
 * HTML and insert rendered children unescaped (design-content-trust.md Q2, Q4).
 */
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadTemplate } from '../src/template-loader.js'
import {
  CHILD_HTML,
  MARKUP,
  RICH_PAYLOAD,
  SCRIPT,
  renderWithPayloads,
  renderWithUnmarkedChild,
  schemaFormat,
  templateNames,
} from './_helpers/template-escape.js'

const templatesDir = resolve(import.meta.dirname, '../../../sites/gazetta.studio/templates')
const COMPOSITES = ['feature-grid', 'section', 'site-footer', 'site-layout']

describe('gazetta.studio templates', () => {
  // doc's content is a whole Markdown string, and code-block's language picks the
  // highlighter (an unknown one throws); both have their own tests below.
  const names = templateNames(templatesDir).filter(name => name !== 'doc' && name !== 'code-block')

  it('covers every composite template named here', () => {
    expect(names).toEqual(expect.arrayContaining([...COMPOSITES, 'text']))
  })

  it.each(names)(
    '%s escapes plain text fields',
    async name => {
      const { html } = await renderWithPayloads(templatesDir, name)
      expect(html).not.toContain('<script')
      expect(html).not.toContain(MARKUP)
      // Every payload that reaches the markup arrives escaped.
      expect(html.split('alert(1)').length).toBe(html.split('&lt;script&gt;alert(1)').length)
    },
    30000,
  )

  it.each(COMPOSITES)('%s inserts rendered children unescaped', async name => {
    const { html } = await renderWithPayloads(templatesDir, name)
    expect(html).toContain(CHILD_HTML)
  })

  it.each(COMPOSITES)('%s escapes a child that is only an object with an html key', async name => {
    const html = await renderWithUnmarkedChild(templatesDir, name)
    expect(html).not.toContain('<em')
  })

  it('text body is a rich-text field rendered as HTML', async () => {
    const { html, hasRich } = await renderWithPayloads(templatesDir, 'text')
    expect(hasRich).toBe(true)
    expect(html).toContain(RICH_PAYLOAD)
    const text = await loadTemplate(undefined, templatesDir, 'text')
    expect(schemaFormat(text.schema, 'body')).toBe('richtext')
  })

  it('hero escapes its text and link fields', async () => {
    const hero = await loadTemplate(undefined, templatesDir, 'hero')
    const output = await hero.render({
      content: { title: SCRIPT, badge: 'New', badgeHref: '/a?x=1&y="2"', cta: 'Go', ctaHref: '/docs' },
    })
    expect(String(output.html)).toContain('<h1>&lt;script&gt;alert(1)&lt;/script&gt;</h1>')
    expect(String(output.html)).toContain('href="/a?x=1&amp;y=&quot;2&quot;"')
  })

  it('doc renders its Markdown as HTML and escapes heading text in the page list', async () => {
    const doc = await loadTemplate(undefined, templatesDir, 'doc')
    const output = await doc.render({ content: '## A <b>bold</b> & safe heading\n\nSome **strong** text.\n' } as never)
    const html = String(output.html)
    expect(html).toContain('<strong>strong</strong>')
    expect(html).toContain('<h2 id=')
    expect(html).not.toContain('<b>bold</b>')
    expect(html).toMatch(
      /<li class="toc-depth-2"><a href="#[^"]+">A &lt;b&gt;bold&lt;\/b&gt; &amp; safe heading<\/a><\/li>/,
    )
  }, 30000)

  it('code-block shows code as highlighted text', async () => {
    const block = await loadTemplate(undefined, templatesDir, 'code-block')
    const output = await block.render({ content: { code: SCRIPT, language: 'TypeScript' } })
    const html = String(output.html)
    expect(html).toContain('<span class="code-lang">TypeScript</span>')
    expect(html).toContain('<pre class="shiki')
    expect(html).not.toContain('<script')
  }, 30000)

  it('docs-nav escapes its labels and links', async () => {
    const nav = await loadTemplate(undefined, templatesDir, 'docs-nav')
    const output = await nav.render({
      content: { groups: [{ title: 'A & B', items: [{ label: '<i>x</i>', href: '/docs/a"b' }] }] },
    })
    const html = String(output.html)
    expect(html).toContain('<h2>A &amp; B</h2>')
    expect(html).toContain('<li><a href="/docs/a&quot;b">&lt;i&gt;x&lt;/i&gt;</a></li>')
  })
})
