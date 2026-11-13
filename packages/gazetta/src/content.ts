import { marked } from 'marked'
import { z } from 'zod'
import { sanitizeContentHtml } from './content-sanitize.js'

type JsonSchema = Record<string, unknown>

/** Converted schemas, per schema object: a template's schema is converted once, not per component. */
const jsonSchemas = new WeakMap<object, JsonSchema>()

/**
 * Prepare content for a template: Markdown fields become HTML, and Markdown
 * and rich-text fields are sanitized, at any depth (objects and list items
 * included). Other values pass through unchanged.
 *
 * A schema that can't be read throws, naming the template: rendering its
 * fields unsanitized would publish whatever HTML they hold
 * (design-content-trust.md Q2).
 */
export function processContent(
  content: Record<string, unknown> | undefined,
  schema: unknown,
  templateName?: string,
): Record<string, unknown> | undefined {
  if (!content || !schema) return content

  const cacheable = typeof schema === 'object' || typeof schema === 'function'
  let root = cacheable ? jsonSchemas.get(schema as object) : undefined
  if (!root) {
    try {
      root = z.toJSONSchema(schema as z.ZodType, { unrepresentable: 'any' }) as JsonSchema
    } catch (err) {
      throw new Error(
        `Template "${templateName ?? '(unknown)'}": its schema can't be read, so its Markdown and rich-text ` +
          `fields can't be sanitized. ${(err as Error).message}`,
      )
    }
    if (cacheable) jsonSchemas.set(schema as object, root)
  }
  return processValue(content, root, root) as Record<string, unknown>
}

/** Follow local `$ref`s (`#`, `#/$defs/name`) that recursive schemas produce. */
function deref(node: JsonSchema, root: JsonSchema): JsonSchema {
  let current = node
  for (let hops = 0; typeof current.$ref === 'string' && hops < 32; hops++) {
    const ref = current.$ref as string
    if (!ref.startsWith('#')) return current
    let target: unknown = root
    for (const part of ref.slice(1).split('/').filter(Boolean)) {
      target = (target as JsonSchema | undefined)?.[decodeURIComponent(part.replace(/~1/g, '/').replace(/~0/g, '~'))]
    }
    if (!target || typeof target !== 'object') return current
    current = target as JsonSchema
  }
  return current
}

/** The node itself plus the branches of `anyOf` / `oneOf` / `allOf` (nullable and optional fields). */
function candidates(node: JsonSchema, root: JsonSchema): JsonSchema[] {
  const self = deref(node, root)
  const out = [self]
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const branches = self[key]
    if (Array.isArray(branches)) {
      for (const b of branches) if (b && typeof b === 'object') out.push(...candidates(b as JsonSchema, root))
    }
  }
  return out
}

function processValue(value: unknown, node: JsonSchema, root: JsonSchema): unknown {
  const nodes = candidates(node, root)

  if (typeof value === 'string') {
    const format = nodes.find(n => n.format === 'markdown' || n.format === 'richtext')?.format
    if (format === 'markdown') return sanitizeContentHtml(marked(value, { async: false }))
    if (format === 'richtext') return sanitizeContentHtml(value)
    return value
  }

  if (Array.isArray(value)) {
    const items = nodes.find(n => n.items && typeof n.items === 'object')?.items as JsonSchema | undefined
    return items ? value.map(v => processValue(v, items, root)) : value
  }

  if (value && typeof value === 'object') {
    const properties = nodes.find(n => n.properties && typeof n.properties === 'object')?.properties as
      | Record<string, JsonSchema>
      | undefined
    if (!properties) return value
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) }
    for (const [key, prop] of Object.entries(properties)) {
      if (key in out) out[key] = processValue(out[key], prop, root)
    }
    return out
  }

  return value
}
