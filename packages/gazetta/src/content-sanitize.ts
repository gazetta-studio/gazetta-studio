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

export function sanitizeContentHtml(markup: string): string {
  return DOMPurify.sanitize(markup, CONFIG) as unknown as string
}
