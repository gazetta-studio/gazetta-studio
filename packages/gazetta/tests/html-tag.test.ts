import { describe, it, expect } from 'vitest'
import { html, raw } from '../src/html.js'
import { renderComponent } from '../src/renderer.js'
import type { ResolvedComponent } from '../src/types.js'

describe('html tag', () => {
  it('escapes interpolated strings', () => {
    expect(String(html`<h1>${'<b>x</b>'}</h1>`)).toBe('<h1>&lt;b&gt;x&lt;/b&gt;</h1>')
  })

  it.each([
    ['ampersand', '&', '&amp;'],
    ['quotes', `"'`, '&quot;&#39;'],
    ['number', 42, '42'],
    ['null', null, ''],
    ['undefined', undefined, ''],
    ['false', false, ''],
  ])('renders %s', (_name, value, expected) => {
    expect(String(html`[${value}]`)).toBe(`[${expected}]`)
  })

  it('inserts raw() values unescaped', () => {
    expect(String(html`<div>${raw('<p>ok</p>')}</div>`)).toBe('<div><p>ok</p></div>')
    expect(String(raw(undefined))).toBe('')
  })

  it("inserts the tag's own results and arrays of them unescaped", () => {
    const links = [
      { href: '/a', label: 'A & B' },
      { href: '/"b', label: '<C>' },
    ]
    const out = html`<nav>${links.map(l => html`<a href="${l.href}">${l.label}</a>`)}</nav>`
    expect(String(out)).toBe('<nav><a href="/a">A &amp; B</a><a href="/&quot;b">&lt;C&gt;</a></nav>')
  })

  it('escapes a plain object that has an html key', () => {
    const fromContent = { html: '<b>', toString: () => '<b>' }
    expect(String(html`${fromContent}`)).toBe('&lt;b&gt;')
  })

  it('escapes plain strings inside arrays', () => {
    expect(String(html`${['<i>', raw('<b>')]}`)).toBe('&lt;i&gt;<b>')
  })

  it('works as a string', () => {
    const out = html`<p>${'x'}</p>`
    expect(String(out)).toBe('<p>x</p>')
    expect(`${out}`).toBe('<p>x</p>')
    expect(out.length).toBe(8)
    expect(out.includes('<p>')).toBe(true)
  })

  it('inserts rendered children from the renderer unescaped, as a list or one by one', async () => {
    const leaf: ResolvedComponent = {
      template: () => ({ html: '<b>child</b>', css: '', js: '' }),
      children: [],
      treePath: 'c',
    }
    const child = await renderComponent(leaf)
    expect(typeof child.html).toBe('string')
    expect(String(html`<header>${[child]}</header>`)).toBe(`<header>${child.html}</header>`)
    expect(String(html`${child}`)).toBe(child.html)
  })
})
