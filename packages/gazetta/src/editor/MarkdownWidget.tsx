import React from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import { Markdown } from '@tiptap/markdown'
import type { WidgetProps } from '@rjsf/utils'
import { FormattingToolbar, formattingExtensions } from './formatting-toolbar.js'

export type MarkdownView = 'formatted' | 'markdown'

/** One choice for every Markdown field in this browser (design-content-trust.md Q8). */
export const MARKDOWN_VIEW_STORAGE_KEY = 'gazetta:markdown-view'

export const FORMATTED_VIEW_NOTE = 'Formatted view may reformat Markdown.'

/**
 * Where the Formatted view reads Markdown differently from `marked`, which
 * renders published pages. Pinned by tests/markdown-roundtrip.test.ts, so a
 * difference can't appear or go away without this list changing.
 */
export const KNOWN_FORMATTED_DIFFERENCES: readonly string[] = []

export const markdownViewNote = () => [FORMATTED_VIEW_NOTE, ...KNOWN_FORMATTED_DIFFERENCES].join(' ')

/**
 * Published Markdown may use any heading level, so the editor accepts all six;
 * with the rich-text field's two levels an `# h1` would become a paragraph.
 */
export function markdownEditorExtensions() {
  return [...formattingExtensions([1, 2, 3, 4, 5, 6]), Markdown]
}

function readStoredView(): MarkdownView {
  try {
    return localStorage.getItem(MARKDOWN_VIEW_STORAGE_KEY) === 'markdown' ? 'markdown' : 'formatted'
  } catch {
    return 'formatted'
  }
}

function storeView(view: MarkdownView) {
  try {
    localStorage.setItem(MARKDOWN_VIEW_STORAGE_KEY, view)
  } catch {
    // Storage can be unavailable (private mode, quota); the choice then lasts for this page only.
  }
}

/**
 * A `format.markdown()` field. The field's string is written only after the
 * author edits it: loading it into the editor or switching views must never
 * rewrite Markdown nobody touched (design-content-trust.md Q8).
 */
export function MarkdownWidget(props: WidgetProps) {
  const onChangeRef = React.useRef(props.onChange)
  onChangeRef.current = props.onChange

  const initial = typeof props.value === 'string' ? props.value : ''
  const [view, setView] = React.useState<MarkdownView>(readStoredView)
  const [source, setSource] = React.useState(initial)
  const sourceRef = React.useRef(initial)
  // The Markdown the editor's document was last loaded from or produced.
  const editorSourceRef = React.useRef(initial)

  const editor = useEditor({
    extensions: markdownEditorExtensions(),
    content: initial,
    contentType: 'markdown',
    immediatelyRender: true,
    onUpdate: ({ editor: e, transaction }) => {
      if (!transaction.docChanged) return
      const md = e.getMarkdown()
      sourceRef.current = md
      editorSourceRef.current = md
      setSource(md)
      onChangeRef.current(md)
    },
  })

  const loadIntoEditor = React.useCallback(
    (md: string) => {
      if (!editor || editorSourceRef.current === md) return
      editor.commands.setContent(md, { contentType: 'markdown', emitUpdate: false })
      editorSourceRef.current = md
    },
    [editor],
  )

  // A value changed from outside the widget (form undo, a reload of the
  // content) replaces what is shown, without being echoed back as an edit.
  React.useEffect(() => {
    const value = typeof props.value === 'string' ? props.value : ''
    if (value === sourceRef.current) return
    sourceRef.current = value
    setSource(value)
    if (view === 'formatted') loadIntoEditor(value)
  }, [props.value, view, loadIntoEditor])

  const switchTo = (next: MarkdownView) => {
    if (next === view) return
    if (next === 'formatted') loadIntoEditor(sourceRef.current)
    setView(next)
    storeView(next)
  }

  const onSourceInput = (value: string) => {
    sourceRef.current = value
    setSource(value)
    onChangeRef.current(value)
  }

  return (
    <div className="gz-markdown" data-testid="markdown-editor">
      <div className="gz-md-modes" role="group" aria-label="Editor view">
        <button
          type="button"
          className="gz-md-mode"
          data-testid="markdown-mode-formatted"
          aria-pressed={view === 'formatted'}
          onClick={() => switchTo('formatted')}
        >
          Formatted
        </button>
        <button
          type="button"
          className="gz-md-mode"
          data-testid="markdown-mode-markdown"
          aria-pressed={view === 'markdown'}
          onClick={() => switchTo('markdown')}
        >
          Markdown
        </button>
      </div>

      {view === 'markdown' && (
        <>
          <div className="gz-md-note" data-testid="markdown-mode-note">
            {markdownViewNote()}
          </div>
          <textarea
            data-testid="markdown-source"
            aria-label={props.label || 'Markdown'}
            value={source}
            onChange={e => onSourceInput(e.target.value)}
            rows={12}
            spellCheck={false}
          />
        </>
      )}

      <div className="gz-richtext" hidden={view !== 'formatted'}>
        {editor && view === 'formatted' && <FormattingToolbar editor={editor} testIdPrefix="markdown" />}
        <EditorContent editor={editor} />
      </div>
    </div>
  )
}
