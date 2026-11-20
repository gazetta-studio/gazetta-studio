import React from 'react'
import type { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'

type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6

/**
 * The Tiptap extensions the rich-text and Markdown fields share, so both
 * edit the same formatting and show the same placeholder.
 */
export function formattingExtensions(headingLevels: HeadingLevel[] = [2, 3]) {
  return [
    StarterKit.configure({
      heading: { levels: headingLevels },
      codeBlock: { HTMLAttributes: { spellcheck: 'false' } },
      // StarterKit 3 bundles Link; configure it here rather than adding
      // Link again, which registers a duplicate extension.
      link: { openOnClick: false, HTMLAttributes: { rel: 'noopener noreferrer' } },
    }),
    Placeholder.configure({ placeholder: 'Start writing...' }),
  ]
}

export function ToolbarButton({
  active,
  onClick,
  testId,
  label,
  children,
}: {
  active?: boolean
  onClick: () => void
  testId?: string
  label: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      className={`gz-rt-btn${active ? ' active' : ''}`}
      data-testid={testId}
      aria-label={label}
      aria-pressed={active ?? undefined}
      title={label}
      // Keeps the editor's selection when the button is clicked; the action
      // runs on click so Enter and Space work from the keyboard too.
      onMouseDown={e => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

export function promptForLink(editor: Editor) {
  const prev = editor.getAttributes('link').href as string | undefined
  const url = prompt('URL:', prev ?? 'https://')
  if (url === null) return
  if (url === '') {
    editor.chain().focus().extendMarkRange('link').unsetLink().run()
    return
  }
  editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
}

/** The fixed formatting toolbar; `testIdPrefix` namespaces each button's test id. */
export function FormattingToolbar({ editor, testIdPrefix }: { editor: Editor; testIdPrefix: string }) {
  const id = (name: string) => `${testIdPrefix}-${name}`
  const run = () => editor.chain()
  return (
    <div className="gz-richtext-toolbar" role="toolbar" aria-label="Formatting">
      <ToolbarButton
        testId={id('bold')}
        label="Bold"
        active={editor.isActive('bold')}
        onClick={() => run().focus().toggleBold().run()}
      >
        B
      </ToolbarButton>
      <ToolbarButton
        testId={id('italic')}
        label="Italic"
        active={editor.isActive('italic')}
        onClick={() => run().focus().toggleItalic().run()}
      >
        I
      </ToolbarButton>
      <ToolbarButton
        testId={id('strike')}
        label="Strikethrough"
        active={editor.isActive('strike')}
        onClick={() => run().focus().toggleStrike().run()}
      >
        S
      </ToolbarButton>
      <ToolbarButton
        testId={id('code')}
        label="Inline code"
        active={editor.isActive('code')}
        onClick={() => run().focus().toggleCode().run()}
      >
        &lt;/&gt;
      </ToolbarButton>
      <div className="gz-rt-sep" />
      <ToolbarButton
        testId={id('h2')}
        label="Heading 2"
        active={editor.isActive('heading', { level: 2 })}
        onClick={() => run().focus().toggleHeading({ level: 2 }).run()}
      >
        H2
      </ToolbarButton>
      <ToolbarButton
        testId={id('h3')}
        label="Heading 3"
        active={editor.isActive('heading', { level: 3 })}
        onClick={() => run().focus().toggleHeading({ level: 3 }).run()}
      >
        H3
      </ToolbarButton>
      <div className="gz-rt-sep" />
      <ToolbarButton
        testId={id('bullet-list')}
        label="Bulleted list"
        active={editor.isActive('bulletList')}
        onClick={() => run().focus().toggleBulletList().run()}
      >
        &bull;
      </ToolbarButton>
      <ToolbarButton
        testId={id('ordered-list')}
        label="Numbered list"
        active={editor.isActive('orderedList')}
        onClick={() => run().focus().toggleOrderedList().run()}
      >
        1.
      </ToolbarButton>
      <ToolbarButton
        testId={id('blockquote')}
        label="Quote"
        active={editor.isActive('blockquote')}
        onClick={() => run().focus().toggleBlockquote().run()}
      >
        &ldquo;
      </ToolbarButton>
      <div className="gz-rt-sep" />
      <ToolbarButton
        testId={id('link')}
        label="Link"
        active={editor.isActive('link')}
        onClick={() => promptForLink(editor)}
      >
        Link
      </ToolbarButton>
      <ToolbarButton testId={id('hr')} label="Horizontal rule" onClick={() => run().focus().setHorizontalRule().run()}>
        &#x2014;
      </ToolbarButton>
      <ToolbarButton
        testId={id('code-block')}
        label="Code block"
        active={editor.isActive('codeBlock')}
        onClick={() => run().focus().toggleCodeBlock().run()}
      >
        Code
      </ToolbarButton>
    </div>
  )
}
