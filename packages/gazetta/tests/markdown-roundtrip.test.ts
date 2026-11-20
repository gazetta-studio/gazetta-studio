// @vitest-environment jsdom
/**
 * The Markdown field's editor (@tiptap/markdown) against the renderer
 * (marked) on the Markdown the starter's pages use, and the guarantee that
 * an untouched field comes back byte-identical (design-content-trust.md Q7, Q8).
 */
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { Editor } from '@tiptap/core'
import { marked } from 'marked'
import type { WidgetProps } from '@rjsf/utils'
import {
  KNOWN_FORMATTED_DIFFERENCES,
  MarkdownWidget,
  markdownEditorExtensions,
  markdownViewNote,
} from '../src/editor/MarkdownWidget.js'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const starterBlogBody = (() => {
  const page = JSON.parse(
    readFileSync(
      resolve(__dirname, '../../../examples/starter/sites/main/targets/local/pages/blog/[slug]/page.json'),
      'utf8',
    ),
  ) as { components: Array<string | { template?: string; content?: { body?: string } }> }
  const md = page.components.find(c => typeof c === 'object' && c.template === 'markdown')
  if (typeof md !== 'object' || typeof md.content?.body !== 'string') throw new Error('starter blog body not found')
  return md.content.body
})()

/** One sample per construct the starter's Markdown pages use, plus the whole page. */
const constructs: Record<string, string> = {
  headings: '# One\n\n## Two\n\n### Three\n',
  emphasis: 'Some **bold** and *italic* words.\n',
  links: 'See [Gazetta](https://gazetta.studio) and [docs](/docs).\n',
  'bullet list': '- one\n- **two**\n- three\n',
  'ordered list': '1. first\n2. second\n',
  blockquote: '> Quoted `code` and *text*.\n',
  'inline code': 'Use `format.markdown()` here.\n',
  'fenced code': '```ts\nconst a = 1\n\nconst b = 2\n```\n',
  'starter blog page': starterBlogBody,
}

/**
 * A comparable outline of rendered HTML: element names, text, link targets
 * and code languages. Drops what differs only in presentation: whitespace
 * between blocks, `<p>` wrapping a list item's text, link `target`/`rel`,
 * and the trailing newline marked keeps in code blocks.
 */
function outline(html: string): string {
  const root = document.createElement('div')
  root.innerHTML = html
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      const inPre = node.parentElement?.closest('pre')
      const text = node.textContent ?? ''
      return inPre ? text.replace(/\n$/, '') : text.replace(/\s+/g, ' ')
    }
    if (!(node instanceof Element)) return ''
    const tag = node.tagName.toLowerCase()
    const children = [...node.childNodes]
    if (tag === 'li' && children.filter(c => c instanceof Element).length === 1 && children[0] instanceof Element) {
      const only = children[0]
      if (only.tagName === 'P') return `<li>${[...only.childNodes].map(walk).join('').trim()}</li>`
    }
    const attrs = [
      tag === 'a' ? ` href="${node.getAttribute('href')}"` : '',
      tag === 'code' && node.getAttribute('class') ? ` class="${node.getAttribute('class')}"` : '',
    ].join('')
    const inner = children
      .map(walk)
      .filter(s => tag === 'pre' || tag === 'code' || s.trim() !== '' || !/^(div|ul|ol|blockquote)$/.test(tag))
      .join('')
    const body = /^(p|li|h[1-6])$/.test(tag) ? inner.trim() : inner
    return `<${tag}${attrs}>${body}</${tag}>`
  }
  return [...root.childNodes]
    .map(walk)
    .filter(s => s.trim() !== '')
    .join('')
}

function editorHtml(md: string): string {
  const editor = new Editor({ extensions: markdownEditorExtensions(), content: md, contentType: 'markdown' })
  try {
    return editor.getHTML()
  } finally {
    editor.destroy()
  }
}

describe('Formatted view parity with marked', () => {
  it.each(Object.entries(constructs))('%s parses to the same structure', (_name, md) => {
    expect(outline(editorHtml(md))).toBe(outline(marked.parse(md, { async: false })))
  })

  // Every construct above matches, so the note names no differences; a
  // construct that stops matching must add its difference to the note.
  it('the Markdown view note lists no differences', () => {
    expect(KNOWN_FORMATTED_DIFFERENCES).toEqual([])
    expect(markdownViewNote()).toBe('Formatted view may reformat Markdown.')
  })

  it('compares structure, not presentation: a real difference is caught', () => {
    expect(outline(editorHtml('# Title\n'))).not.toBe(outline(marked.parse('Title\n', { async: false })))
  })
})

describe('untouched Markdown comes back byte-identical', () => {
  let container: HTMLDivElement | undefined
  let root: ReturnType<typeof createRoot> | undefined
  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    localStorage.clear()
  })

  it.each(Object.entries(constructs))('%s: loading and switching views writes nothing', (_name, md) => {
    const calls: unknown[] = []
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const props = { id: 'root_body', value: md, onChange: (v: unknown) => calls.push(v), label: 'Body' }
    act(() => root?.render(React.createElement(MarkdownWidget, props as unknown as WidgetProps)))
    const click = (id: string) =>
      act(() => (container?.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement).click())
    click('markdown-mode-markdown')
    expect((container.querySelector('[data-testid="markdown-source"]') as HTMLTextAreaElement).value).toBe(md)
    click('markdown-mode-formatted')
    click('markdown-mode-markdown')
    expect((container.querySelector('[data-testid="markdown-source"]') as HTMLTextAreaElement).value).toBe(md)
    expect(calls).toEqual([])
  })
})
