import type { RenderOutput, ResolvedComponent, PageMetadata } from './types.js'
import { hashPath, scopeHtml, scopeCss } from './scope.js'
import { resolveSeoTags, escapeAttr, type SeoContext } from './seo.js'
import { markRendered } from './html.js'

export { type SeoContext } from './seo.js'

const THROWN_BY = Symbol.for('gazetta.thrownByTemplate')

/**
 * Call a component's template; when it throws, mark the error with the
 * template's name, so `gazetta validate --render` can say which template
 * threw (#1755). The error itself, and its message, are unchanged.
 */
export async function callTemplate(
  component: ResolvedComponent,
  params: Parameters<ResolvedComponent['template']>[0],
): Promise<Awaited<ReturnType<ResolvedComponent['template']>>> {
  try {
    const output = await component.template(params)
    // The `html` tag returns a String object; `RenderOutput.html` stays a plain string.
    return (output.html as unknown) instanceof String ? { ...output, html: String(output.html) } : output
  } catch (err) {
    if (component.templateName && typeof err === 'object' && err !== null && !(THROWN_BY in err)) {
      try {
        Object.defineProperty(err, THROWN_BY, { value: component.templateName })
      } catch {
        // A frozen error stays unmarked; the caller falls back to the item's template.
      }
    }
    throw err
  }
}

/** The template that threw `err` during a render, when known. */
export function thrownByTemplate(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const name = (err as Record<symbol, unknown>)[THROWN_BY]
  return typeof name === 'string' ? name : undefined
}

export async function renderComponent(
  component: ResolvedComponent,
  routeParams?: Record<string, string>,
  locale = 'en',
): Promise<RenderOutput> {
  const children = await Promise.all(component.children.map(c => renderComponent(c, routeParams, locale)))
  const output = await callTemplate(component, { content: component.content, children, params: routeParams, locale })

  const scopeId = hashPath(component.treePath ?? '')

  const headParts = [...children.map(c => c.head).filter(Boolean), output.head].filter(Boolean)

  // Marked so a parent template's `html` tag inserts it unescaped (design-content-trust.md Q2).
  return markRendered({
    html: scopeHtml(output.html, scopeId),
    css: scopeCss(output.css, scopeId),
    js: output.js,
    head: headParts.length ? headParts.join('\n') : undefined,
  })
}

export async function renderFragment(component: ResolvedComponent, locale?: string): Promise<string> {
  const lang = locale || 'en'
  const children = await Promise.all(component.children.map(c => renderComponent(c, undefined, lang)))
  const output = await callTemplate(component, { content: component.content, children, locale: lang })

  const headContent = [...children.map(c => c.head).filter(Boolean), output.head].filter(Boolean).join('\n  ')

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${headContent}
  <style>${output.css}</style>
</head>
<body>
${output.html}${output.js ? `\n<script type="module">${output.js}</script>` : ''}
</body>
</html>`
}

export interface RenderPageOptions {
  routeParams?: Record<string, string>
  metadata?: PageMetadata
  /** Page route (e.g. "/about") — used for canonical URL fallback. */
  route?: string
  /** Site-level SEO context for fallback chains. */
  seo?: SeoContext
}

export async function renderPage(
  component: ResolvedComponent,
  optsOrParams?: RenderPageOptions | Record<string, string>,
): Promise<string> {
  const opts: RenderPageOptions =
    optsOrParams &&
    ('metadata' in optsOrParams || 'routeParams' in optsOrParams || 'seo' in optsOrParams || 'route' in optsOrParams)
      ? (optsOrParams as RenderPageOptions)
      : { routeParams: optsOrParams as Record<string, string> | undefined }
  const seo = opts.seo ?? {}
  const lang = seo.locale || 'en'
  const children = await Promise.all(component.children.map(c => renderComponent(c, opts.routeParams, lang)))
  const output = await callTemplate(component, {
    content: component.content,
    children,
    params: opts.routeParams,
    locale: lang,
  })

  const templateHead = [...children.map(c => c.head).filter(Boolean), output.head].filter(Boolean).join('\n  ')
  const seoHead = resolveSeoTags({
    metadata: opts.metadata,
    content: component.content,
    route: opts.route,
    seo,
    templateHead,
  })
  const headContent = [seoHead, templateHead].filter(Boolean).join('\n  ')

  return `<!DOCTYPE html>
<html lang="${escapeAttr(lang)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${headContent}
  <style>${output.css}</style>
</head>
<body>
${output.html}${output.js ? `\n<script type="module">${output.js}</script>` : ''}
</body>
</html>`
}
