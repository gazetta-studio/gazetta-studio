/**
 * `html` template tag for template authors: interpolated values are escaped
 * unless they are trusted. Trusted values are `raw()` results, the tag's own
 * results, and rendered children the renderer marks (design-content-trust.md
 * Q2). Trust lives in a non-enumerable symbol, so plain content objects that
 * happen to carry an `html` key are never trusted.
 */

const TRUSTED_HTML = Symbol.for('gazetta.trustedHtml')
const RENDERED_OUTPUT = Symbol.for('gazetta.renderedOutput')

/**
 * Markup the `html` tag inserts without escaping. A `String` object at
 * runtime, so it still works wherever a string does (`String()`, template
 * literals, `.length`, string methods); typed as a branded string so it can
 * be returned as `RenderOutput.html`.
 */
export type SafeHtml = string & { readonly __safeHtml: true }

function trusted(markup: string): SafeHtml {
  const value = new String(markup)
  Object.defineProperty(value, TRUSTED_HTML, { value: true })
  return value as unknown as SafeHtml
}

function isTrusted(value: unknown): boolean {
  return value instanceof String && (value as unknown as Record<symbol, unknown>)[TRUSTED_HTML] === true
}

function isRenderedOutput(value: unknown): value is { html: unknown } {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[RENDERED_OUTPUT] === true
}

/**
 * Mark a rendered component output so `html` inserts its markup as is. Only
 * the renderer calls this; `c.html` stays a plain string.
 */
export function markRendered<T extends object>(output: T): T {
  Object.defineProperty(output, RENDERED_OUTPUT, { value: true })
  return output
}

/** Insert `markup` unescaped. Use it for Markdown and rich-text fields, which are sanitized at render. */
export function raw(markup: unknown): SafeHtml {
  return trusted(markup === null || markup === undefined ? '' : String(markup))
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** Escape text for HTML element content and quoted attribute values. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => ESCAPES[ch])
}

function interpolate(value: unknown): string {
  if (value === null || value === undefined || value === false) return ''
  if (Array.isArray(value)) return value.map(interpolate).join('')
  if (isTrusted(value)) return String(value)
  if (isRenderedOutput(value)) return String(value.html ?? '')
  return escapeHtml(String(value))
}

/** Escaping template tag: `` html`<h1>${content.title}</h1>` ``. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0]
  for (let i = 0; i < values.length; i++) out += interpolate(values[i]) + strings[i + 1]
  return trusted(out)
}
