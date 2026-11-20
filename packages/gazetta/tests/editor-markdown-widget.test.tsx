// @vitest-environment jsdom
/**
 * The `format.markdown()` widget (design-content-trust.md Q7, Q8 and its
 * state table): a Tiptap editor that stores Markdown, with a
 * Formatted/Markdown toggle remembered per browser, that never rewrites a
 * field the author didn't edit.
 */
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { z } from 'zod'
import type { Editor } from '@tiptap/core'
import { format } from '../src/formats.js'
import { DefaultEditorForm } from '../src/editor/mount.js'
import { MARKDOWN_VIEW_STORAGE_KEY } from '../src/editor/MarkdownWidget.js'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  localStorage.clear()
  document.documentElement.removeAttribute('dir')
})

const bodySchema = z.object({ body: z.string().meta(format.markdown()) })

function renderForm(
  schema: z.ZodType,
  content: Record<string, unknown>,
  onChange: (c: Record<string, unknown>) => void,
) {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>
  act(() => {
    root.render(React.createElement(DefaultEditorForm, { schema: jsonSchema, content, onChange }))
  })
}

const q = <T extends Element = HTMLElement>(testId: string, scope: ParentNode = container) =>
  scope.querySelector<T & Element>(`[data-testid="${testId}"]`) as (T & Element) | null

const click = (testId: string) => act(() => (q<HTMLButtonElement>(testId) as HTMLButtonElement).click())

/** The Tiptap editor behind the visible ProseMirror element. */
const tiptap = () => (container.querySelector('.tiptap') as HTMLElement & { editor: Editor }).editor

function typeInto(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  act(() => {
    setter?.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('Markdown field widget', () => {
  it('opens in the formatted view with the toolbar and the placeholder when empty', () => {
    renderForm(bodySchema, { body: '' }, () => {})
    expect(q('markdown-editor')).not.toBeNull()
    expect(q('markdown-mode-formatted')?.getAttribute('aria-pressed')).toBe('true')
    expect(q('markdown-mode-markdown')?.getAttribute('aria-pressed')).toBe('false')
    expect(q('markdown-source')).toBeNull()
    expect(q('markdown-bold')).not.toBeNull()
    expect(container.querySelector('.tiptap p')?.getAttribute('data-placeholder')).toBe('Start writing...')
  })

  it.each([
    ['top-level', bodySchema, { body: 'Hi' }],
    ['array item', z.object({ items: z.array(z.string().meta(format.markdown())) }), { items: ['Hi'] }],
    [
      'nested object',
      z.object({ section: z.object({ text: z.string().meta(format.markdown()) }) }),
      { section: { text: 'Hi' } },
    ],
  ])('a %s Markdown field gets the editor', (_where, schema, content) => {
    renderForm(schema, content, () => {})
    expect(q('markdown-editor')).not.toBeNull()
    expect(container.querySelector('.tiptap')?.textContent).toBe('Hi')
  })

  it('switches views with aria-pressed and restores the chosen view on the next mount', () => {
    renderForm(bodySchema, { body: 'Hi' }, () => {})
    click('markdown-mode-markdown')
    expect(q('markdown-mode-markdown')?.getAttribute('aria-pressed')).toBe('true')
    expect(q('markdown-mode-formatted')?.getAttribute('aria-pressed')).toBe('false')
    expect(q('markdown-bold')).toBeNull()
    expect(localStorage.getItem(MARKDOWN_VIEW_STORAGE_KEY)).toBe('markdown')

    act(() => root.unmount())
    root = createRoot(container)
    renderForm(bodySchema, { body: 'Hi' }, () => {})
    expect(q('markdown-mode-markdown')?.getAttribute('aria-pressed')).toBe('true')
    expect(q<HTMLTextAreaElement>('markdown-source')?.value).toBe('Hi')

    click('markdown-mode-formatted')
    expect(localStorage.getItem(MARKDOWN_VIEW_STORAGE_KEY)).toBe('formatted')
  })

  it('passes what is typed in the Markdown view to onChange exactly as typed', () => {
    const changes: Record<string, unknown>[] = []
    renderForm(bodySchema, { body: '' }, c => changes.push(c))
    click('markdown-mode-markdown')
    const typed = '* star list\n*  two spaces*\n\n\n__under__  \ntrailing   '
    typeInto(q<HTMLTextAreaElement>('markdown-source') as HTMLTextAreaElement, typed)
    expect(changes.at(-1)).toEqual({ body: typed })
  })

  it('never calls onChange on mount or when switching views without an edit', () => {
    const md = '# Title\n\n* star bullet\n* two\n\nA __bold__ word.\n'
    const changes: unknown[] = []
    renderForm(bodySchema, { body: md }, c => changes.push(c))
    click('markdown-mode-markdown')
    click('markdown-mode-formatted')
    click('markdown-mode-markdown')
    expect(q<HTMLTextAreaElement>('markdown-source')?.value).toBe(md)
    expect(changes).toEqual([])
  })

  it('saves formatting applied in the formatted view as Markdown, not HTML', () => {
    const changes: Record<string, unknown>[] = []
    renderForm(bodySchema, { body: 'make me bold' }, c => changes.push(c))
    act(() => {
      tiptap().commands.selectAll()
    })
    click('markdown-bold')
    expect(changes.at(-1)).toEqual({ body: '**make me bold**' })
    click('markdown-mode-markdown')
    expect(q<HTMLTextAreaElement>('markdown-source')?.value).toBe('**make me bold**')
  })

  it('re-reads edits made in the Markdown view when switching back to formatted', () => {
    renderForm(bodySchema, { body: 'old' }, () => {})
    click('markdown-mode-markdown')
    typeInto(q<HTMLTextAreaElement>('markdown-source') as HTMLTextAreaElement, '## New heading')
    click('markdown-mode-formatted')
    expect(container.querySelector('.tiptap h2')?.textContent).toBe('New heading')
  })

  it('shows the reformatting note only in the Markdown view', () => {
    renderForm(bodySchema, { body: 'Hi' }, () => {})
    expect(q('markdown-mode-note')).toBeNull()
    click('markdown-mode-markdown')
    expect(q('markdown-mode-note')?.textContent).toBe('Formatted view may reformat Markdown.')
  })

  it('gives every toolbar and toggle button a keyboard-reachable name', () => {
    renderForm(bodySchema, { body: 'Hi' }, () => {})
    const buttons = [...(q('markdown-editor') as HTMLElement).querySelectorAll('button')]
    expect(buttons.length).toBeGreaterThan(2)
    for (const b of buttons) {
      expect(b.getAttribute('type')).toBe('button')
      expect(b.tabIndex).toBe(0)
      expect(b.getAttribute('aria-label') || b.textContent?.trim()).toBeTruthy()
    }
    expect(q('markdown-bold')?.getAttribute('aria-label')).toBe('Bold')
  })

  it('follows the admin direction in both views: no direction set on the widget', () => {
    document.documentElement.setAttribute('dir', 'rtl')
    renderForm(bodySchema, { body: 'مرحبا' }, () => {})
    const editorRoot = q('markdown-editor') as HTMLElement
    const withDir = () => [editorRoot, ...editorRoot.querySelectorAll('*')].filter(el => el.hasAttribute('dir'))
    expect(withDir()).toEqual([])
    click('markdown-mode-markdown')
    expect(withDir()).toEqual([])
  })

  it('styles the Markdown and rich-text editors with logical properties only, so RTL flips them', () => {
    const source = readFileSync(resolve(__dirname, '../src/editor/mount.tsx'), 'utf8')
    const block = source.slice(source.indexOf('/* ---- Markdown ---- */'), source.indexOf('/* Bubble menu */'))
    expect(block).toContain('.gz-md-mode')
    expect(block).not.toMatch(/(margin|padding|border)-(left|right)\b|float:\s*(left|right)|text-align:\s*(left|right)/)
  })
})
