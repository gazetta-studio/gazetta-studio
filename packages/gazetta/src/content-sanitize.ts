/**
 * Sanitizer for HTML that comes from content (Markdown and rich-text
 * fields). Content may carry formatting, links and images; script, event
 * handlers, forms, embeds and inline styles come only through templates
 * (design-content-trust.md Q1, Q2).
 *
 * The config is passed per call: `svg-sanitize.ts` resets DOMPurify's
 * global hooks with `removeAllHooks()`, so this module must not rely on
 * hooks.
 */
import DOMPurify from 'isomorphic-dompurify'

const FORBID_TAGS = [
  'script',
  'style',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'option',
  'optgroup',
  'datalist',
  'fieldset',
  'legend',
  'label',
  'output',
  'meter',
  'progress',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'portal',
  'link',
  'meta',
  'base',
]

const FORBID_ATTR = ['style', 'action', 'formaction', 'form']

const CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS,
  FORBID_ATTR,
  // DOMPurify drops `target` by default; links in content keep opening in a new tab.
  ADD_ATTR: ['target', 'rel'],
}

/** `target` values that never open a new browsing context. */
const SAME_CONTEXT_TARGETS = new Set(['', '_self', '_parent', '_top'])

export function sanitizeContentHtml(markup: string): string {
  const clean = DOMPurify.sanitize(markup, CONFIG) as unknown as string
  return /\s(?:rel|target)=/.test(clean) ? fixLinkRel(clean) : clean
}

/**
 * An opening tag as DOMPurify serializes it: attribute values always
 * double-quoted, a `"` inside one written as `&quot;`, and a `<` in text
 * written as `&lt;`, so this matches every tag exactly.
 */
const OPEN_TAG = /<([a-zA-Z][^\s/>]*)((?:\s+[^\s"'>/=]+(?:="[^"]*")?)*)(\s*\/?)>/g
const ATTR = /\s+([^\s"'>/=]+)(?:="([^"]*)")?/g

/**
 * Keeping `rel` and `target` must not hand the opened page a handle on this
 * one: `rel="opener"` is dropped, and an element that opens a new browsing
 * context gets `noopener`. Done on the sanitized string, not in a DOMPurify
 * hook (`svg-sanitize.ts` clears global hooks) and not on a returned DOM
 * (`RETURN_DOM` leaks: the 5K-page bench ran out of memory with it).
 */
function fixLinkRel(html: string): string {
  return html.replace(OPEN_TAG, (tag, name: string, attrs: string, end: string) => {
    let rel: string | undefined
    let target: string | undefined
    const kept: string[] = []
    for (const [, attr, value = ''] of attrs.matchAll(ATTR)) {
      const lower = attr.toLowerCase()
      if (lower === 'rel') rel = value
      else {
        if (lower === 'target') target = value
        kept.push(` ${attr}="${value}"`)
      }
    }
    const original = (rel ?? '').split(/\s+/).filter(Boolean)
    const tokens = original.filter(t => t.toLowerCase() !== 'opener')
    const opensNew = target !== undefined && !SAME_CONTEXT_TARGETS.has(target.trim().toLowerCase())
    if (opensNew && !tokens.some(t => t.toLowerCase() === 'noopener')) tokens.push('noopener')
    if (tokens.join(' ') === original.join(' ')) return tag
    const relAttr = tokens.length ? ` rel="${tokens.join(' ')}"` : ''
    return `<${name}${kept.join('')}${relAttr}${end}>`
  })
}
