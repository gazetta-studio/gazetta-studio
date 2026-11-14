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
      // Stored content is the schema's input: a `.transform()` on a Markdown field keeps its format there.
      root = z.toJSONSchema(schema as z.ZodType, { io: 'input', unrepresentable: 'any' }) as JsonSchema
    } catch (err) {
      throw new Error(
        `Template "${templateName ?? '(unknown)'}": its schema can't be read, so its Markdown and rich-text ` +
          `fields can't be sanitized. ${(err as Error).message}`,
      )
    }
    if (cacheable) jsonSchemas.set(schema as object, root)
  }
  return processValue(content, [root], root) as Record<string, unknown>
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

function isSchema(value: unknown): value is JsonSchema {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Every schema a value must be checked against: the given nodes, what their
 * `$ref`s point to, and every branch of `anyOf` / `oneOf` / `allOf` (unions,
 * nullable and optional fields, intersections). All branches count, so a
 * Markdown field in a later union branch is found too. `seen` stops recursive
 * schemas (`z.lazy(() => z.union([md, Y]))`) from looping.
 */
function candidates(nodes: readonly JsonSchema[], root: JsonSchema): JsonSchema[] {
  const out: JsonSchema[] = []
  const seen = new Set<JsonSchema>()
  const visit = (node: JsonSchema): void => {
    if (seen.has(node)) return
    seen.add(node)
    out.push(node)
    if (typeof node.$ref === 'string') {
      const target = deref(node, root)
      if (target !== node) visit(target)
    }
    for (const key of ['anyOf', 'oneOf', 'allOf']) {
      const branches = node[key]
      if (Array.isArray(branches)) for (const b of branches) if (isSchema(b)) visit(b)
    }
  }
  for (const n of nodes) visit(n)
  return out
}

/** Schemas for one key: `properties`, else matching `patternProperties`, else `additionalProperties` (records, catchall). */
function propertySchemas(nodes: readonly JsonSchema[], key: string): JsonSchema[] {
  const out: JsonSchema[] = []
  for (const n of nodes) {
    const declared = isSchema(n.properties) ? n.properties : undefined
    if (declared && Object.hasOwn(declared, key)) {
      if (isSchema(declared[key])) out.push(declared[key])
      continue
    }
    let matched = false
    if (isSchema(n.patternProperties)) {
      for (const [pattern, sub] of Object.entries(n.patternProperties)) {
        let re: RegExp
        try {
          re = new RegExp(pattern, 'u')
        } catch {
          continue
        }
        if (isSchema(sub) && re.test(key)) {
          out.push(sub)
          matched = true
        }
      }
    }
    if (!matched && isSchema(n.additionalProperties)) out.push(n.additionalProperties)
  }
  return out
}

/** Schemas for array element `index`: `prefixItems[index]` (tuples), else `items`. */
function itemSchemas(nodes: readonly JsonSchema[], index: number): JsonSchema[] {
  const out: JsonSchema[] = []
  for (const n of nodes) {
    const prefix = Array.isArray(n.prefixItems) ? n.prefixItems : undefined
    if (prefix && index < prefix.length) {
      if (isSchema(prefix[index])) out.push(prefix[index])
    } else if (isSchema(n.items)) {
      out.push(n.items)
    }
  }
  return out
}

/**
 * Process a value once, against every schema it may match together: a
 * Markdown or rich-text format in any of them is applied, so no union branch
 * lets a value through raw, and no value is converted twice.
 */
function processValue(value: unknown, schemas: readonly JsonSchema[], root: JsonSchema): unknown {
  if (schemas.length === 0) return value
  const nodes = candidates(schemas, root)

  if (typeof value === 'string') {
    if (nodes.some(n => n.format === 'markdown')) return sanitizeContentHtml(marked(value, { async: false }))
    if (nodes.some(n => n.format === 'richtext')) return sanitizeContentHtml(value)
    return value
  }

  if (Array.isArray(value)) {
    return value.map((v, i) => processValue(v, itemSchemas(nodes, i), root))
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) }
    for (const key of Object.keys(out)) out[key] = processValue(out[key], propertySchemas(nodes, key), root)
    return out
  }

  return value
}
