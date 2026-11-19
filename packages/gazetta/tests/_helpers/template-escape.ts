/**
 * Shared checks for shipped templates (design-content-trust.md Q2, Q4):
 * plain text fields come out escaped, Markdown and rich-text fields come out
 * as HTML, and rendered children go in unescaped.
 */
import { readdirSync } from 'node:fs'
import { z } from 'zod'
import { loadTemplate } from '../../src/template-loader.js'
import { renderComponent } from '../../src/renderer.js'
import type { ResolvedComponent, TemplateFunction } from '../../src/types.js'

export const SCRIPT = '<script>alert(1)</script>'
export const MARKUP = '<b>x</b>'
/** What every plain text field receives. */
export const PLAIN_PAYLOAD = `${SCRIPT}${MARKUP}`
/** What every Markdown or rich-text field receives (already HTML, as after `processContent`). */
export const RICH_PAYLOAD = '<p><strong>rich</strong> <a href="/x">link</a></p>'
/** The markup a rendered child contributes. */
export const CHILD_HTML = '<em data-child="1">child</em>'

type JsonSchema = {
  type?: string | string[]
  format?: string
  enum?: unknown[]
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
  assetOptions?: unknown
}

export interface FilledContent {
  content: unknown
  /** True when at least one Markdown or rich-text field got `RICH_PAYLOAD`. */
  hasRich: boolean
}

/** Content for `schema` with every string field set to a payload chosen by its format. */
export function fillContent(schema: unknown): FilledContent {
  const json = z.toJSONSchema(schema as z.ZodType, { unrepresentable: 'any' }) as JsonSchema
  const state = { hasRich: false }
  const fill = (s: JsonSchema): unknown => {
    if (s.assetOptions) {
      return { url: '/assets/a.png', alt: PLAIN_PAYLOAD, srcset: null, width: 10, height: 10 }
    }
    if (s.enum) return s.enum[0]
    const type = Array.isArray(s.type) ? s.type[0] : s.type
    if (type === 'object') {
      return Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, fill(v)]))
    }
    if (type === 'array') return s.items ? [fill(s.items)] : []
    if (type === 'number' || type === 'integer') return 1
    if (type === 'boolean') return false
    if (type === 'string') {
      if (s.format === 'richtext' || s.format === 'markdown') {
        state.hasRich = true
        return RICH_PAYLOAD
      }
      return PLAIN_PAYLOAD
    }
    return undefined
  }
  const content = fill(json)
  return { content, ...state }
}

export function templateNames(templatesDir: string): string[] {
  return readdirSync(templatesDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('_'))
    .map(entry => entry.name)
    .sort()
}

const childTemplate: TemplateFunction = () => ({ html: CHILD_HTML, css: '', js: '' })

/** Render `name` through the real renderer, with one rendered child. */
export async function renderWithPayloads(templatesDir: string, name: string) {
  const loaded = await loadTemplate(undefined, templatesDir, name)
  const filled = fillContent(loaded.schema)
  const component: ResolvedComponent = {
    template: loaded.render,
    templateName: name,
    content: filled.content as Record<string, unknown>,
    children: [{ template: childTemplate, children: [], treePath: `${name}/child` }],
    treePath: name,
  }
  const output = await renderComponent(component)
  return { ...filled, html: output.html, loaded }
}

/**
 * Call `name`'s template directly with a child that is a plain object, not
 * one the renderer marked: its `html` must be escaped.
 */
export async function renderWithUnmarkedChild(templatesDir: string, name: string): Promise<string> {
  const loaded = await loadTemplate(undefined, templatesDir, name)
  const { content } = fillContent(loaded.schema)
  const output = await loaded.render({
    content: content as Record<string, unknown>,
    children: [{ html: CHILD_HTML, css: '', js: '' }],
  })
  return String(output.html)
}

export function schemaFormat(schema: unknown, field: string): string | undefined {
  const json = z.toJSONSchema(schema as z.ZodType, { unrepresentable: 'any' }) as JsonSchema
  return json.properties?.[field]?.format
}
