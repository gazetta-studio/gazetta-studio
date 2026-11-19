/**
 * The starter's templates escape plain text, insert Markdown and rich-text
 * fields as HTML and insert rendered children unescaped
 * (design-content-trust.md Q2, Q4).
 */
import { describe, expect, it } from 'vitest'
import { loadTemplate } from '../src/template-loader.js'
import {
  CHILD_HTML,
  MARKUP,
  PLAIN_PAYLOAD,
  RICH_PAYLOAD,
  SCRIPT,
  renderWithPayloads,
  renderWithUnmarkedChild,
  schemaFormat,
  templateNames,
} from './_helpers/template-escape.js'
import { starterTemplatesDir } from './_helpers/starter.js'

const COMPOSITES = ['card-grid', 'features-grid', 'footer-layout', 'header-layout', 'page-default', 'two-column']
const RICH = ['blog-post', 'markdown', 'showcase', 'text-block']

describe('starter templates', () => {
  const names = templateNames(starterTemplatesDir)

  it('covers every composite and rich-text template named here', () => {
    expect(names).toEqual(expect.arrayContaining([...COMPOSITES, ...RICH]))
  })

  it.each(names)('%s escapes plain text fields', async name => {
    const { html } = await renderWithPayloads(starterTemplatesDir, name)
    expect(html).not.toContain('<script')
    expect(html).not.toContain(MARKUP)
    // Every payload that reaches the markup arrives escaped.
    expect(html.split('alert(1)').length).toBe(html.split('&lt;script&gt;alert(1)').length)
  })

  it.each(RICH)('%s renders its Markdown or rich-text field as HTML', async name => {
    const { html, hasRich } = await renderWithPayloads(starterTemplatesDir, name)
    expect(hasRich).toBe(true)
    expect(html).toContain(RICH_PAYLOAD)
  })

  it.each(COMPOSITES)('%s inserts rendered children unescaped', async name => {
    const { html } = await renderWithPayloads(starterTemplatesDir, name)
    expect(html).toContain(CHILD_HTML)
  })

  it.each(COMPOSITES)('%s escapes a child that is only an object with an html key', async name => {
    const html = await renderWithUnmarkedChild(starterTemplatesDir, name)
    expect(html).not.toContain('<em')
  })

  it('two-column puts the first child in the sidebar and the rest in main', async () => {
    const two = await loadTemplate(undefined, starterTemplatesDir, 'two-column')
    const child = (text: string) => ({ html: `<i>${text}</i>`, css: '', js: '' })
    const { renderComponent } = await import('../src/renderer.js')
    const output = await renderComponent({
      template: two.render,
      children: ['side', 'one', 'two'].map(text => ({ template: () => child(text), children: [], treePath: text })),
      treePath: 'cols',
    })
    expect(output.html).toMatch(/<aside class="two-col-sidebar"><div[^>]*><i>side<\/i><\/div><\/aside>/)
    expect(output.html).toMatch(
      /<div class="two-col-main"><div[^>]*><i>one<\/i><\/div><div[^>]*><i>two<\/i><\/div><\/div>/,
    )
  })

  it('showcase shows its code snippet as text', async () => {
    const showcase = await loadTemplate(undefined, starterTemplatesDir, 'showcase')
    const output = await showcase.render({
      content: { body: '', snippet: '<div class="hero">\n  <h1>Hi</h1>\n</div>' },
    })
    expect(String(output.html)).toContain(
      '<div class="showcase-snippet">&lt;div class=&quot;hero&quot;&gt;\n  &lt;h1&gt;Hi&lt;/h1&gt;\n&lt;/div&gt;</div>',
    )
  })

  it('text-block body is a rich-text field rendered as HTML', async () => {
    const block = await loadTemplate(undefined, starterTemplatesDir, 'text-block')
    expect(schemaFormat(block.schema, 'body')).toBe('richtext')
    const output = await block.render({
      content: { heading: SCRIPT, body: "<p>Gone. <a href='/'>Go home</a>.</p>" },
    })
    expect(String(output.html)).toContain("<p>Gone. <a href='/'>Go home</a>.</p>")
    expect(String(output.html)).toContain('<h2>&lt;script&gt;')
  })

  it('escapes plain text without double-encoding it', async () => {
    const hero = await loadTemplate(undefined, starterTemplatesDir, 'hero')
    const output = await hero.render({ content: { title: 'Tom & Jerry', subtitle: PLAIN_PAYLOAD } })
    expect(String(output.html)).toContain('<h1>Tom &amp; Jerry</h1>')
    expect(String(output.html)).not.toContain('&amp;amp;')
    expect(String(output.html)).toContain('<p>&lt;script&gt;alert(1)&lt;/script&gt;&lt;b&gt;x&lt;/b&gt;</p>')
  })
})
