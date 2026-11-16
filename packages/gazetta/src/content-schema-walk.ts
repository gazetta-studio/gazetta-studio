/**
 * The walk that decides what kind of field each content value is (Markdown,
 * rich text, code, file, plain text). `processContent` (the sanitizer) and
 * the `script-in-text` save check both use it, so they can't classify a
 * field differently (design-content-trust.md Q2).
 */
import { z } from 'zod'

export type JsonSchema = Record<string, unknown>

/** A template's schema that `z.toJSONSchema` can't convert, even tolerantly. */
export class UnreadableSchemaError extends Error {
  constructor(
    readonly templateName: string,
    readonly reason: string,
  ) {
    super(
      `Template "${templateName}": its schema can't be read, so its Markdown and rich-text ` +
        `fields can't be sanitized. ${reason}`,
    )
    this.name = 'UnreadableSchemaError'
  }
}

/** Converted schemas, per schema object: a template's schema is converted once, not per component. */
const jsonSchemas = new WeakMap<object, JsonSchema>()

/**
 * The JSON Schema content is read against. Stored content is the schema's
 * input, so a `.transform()` on a Markdown field keeps its format there.
 * Throws `UnreadableSchemaError` when the schema can't be converted.
 */
export function contentJsonSchema(schema: unknown, templateName?: string): JsonSchema {
  const cacheable = (typeof schema === 'object' && schema !== null) || typeof schema === 'function'
  const cached = cacheable ? jsonSchemas.get(schema as object) : undefined
  if (cached) return cached
  let root: JsonSchema
  try {
    root = z.toJSONSchema(schema as z.ZodType, { io: 'input', unrepresentable: 'any' }) as JsonSchema
  } catch (err) {
    throw new UnreadableSchemaError(templateName ?? '(unknown)', (err as Error).message)
  }
  if (cacheable) jsonSchemas.set(schema as object, root)
  return root
}

/** What the walk knows about one string value. */
export interface ContentString {
  /** Path from the component's content root (`['items', 0, 'title']`). */
  readonly path: readonly (string | number)[]
  readonly value: string
  /** Every `format` the value's schemas declare (all union branches count). */
  readonly formats: ReadonlySet<string>
  /** The schemas the value must match. */
  readonly nodes: readonly JsonSchema[]
  /**
   * The field's label: its schema `title`, else its property key. A list
   * item without a title of its own is named by its list.
   */
  readonly label: string | undefined
}

/**
 * Rebuild `content`, passing every string to `fn` with what its schema says
 * about it; non-string values are copied. Strings no schema describes
 * (`z.any()`, `z.record(z.string(), z.unknown())`, undeclared keys) reach
 * `fn` too, with no formats, so the save check sees them as plain text.
 */
export function mapContentStrings(content: unknown, root: JsonSchema, fn: (s: ContentString) => string): unknown {
  return mapValue(content, [root], root, [], undefined, fn)
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

function titleOf(nodes: readonly JsonSchema[]): string | undefined {
  for (const n of nodes) if (typeof n.title === 'string' && n.title) return n.title
  return undefined
}

/**
 * Visit a value once, against every schema it may match together: a format
 * in any of them counts, so no union branch lets a value through unseen, and
 * no value is visited twice.
 */
function mapValue(
  value: unknown,
  schemas: readonly JsonSchema[],
  root: JsonSchema,
  path: (string | number)[],
  label: string | undefined,
  fn: (s: ContentString) => string,
): unknown {
  const nodes = candidates(schemas, root)
  const ownLabel = titleOf(nodes) ?? label

  if (typeof value === 'string') {
    const formats = new Set<string>()
    for (const n of nodes) if (typeof n.format === 'string') formats.add(n.format)
    return fn({ path, value, formats, nodes, label: ownLabel })
  }

  if (Array.isArray(value)) {
    return value.map((v, i) => mapValue(v, itemSchemas(nodes, i), root, [...path, i], ownLabel, fn))
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) }
    for (const key of Object.keys(out)) {
      out[key] = mapValue(out[key], propertySchemas(nodes, key), root, [...path, key], key, fn)
    }
    return out
  }

  return value
}
