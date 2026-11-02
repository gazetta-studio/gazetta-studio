/**
 * Walks a JSON Schema (converted from a template's Zod schema) and returns
 * the field paths where `assetOptions.altRequired === true`.
 *
 * Field paths use dot notation; arrays use `[]`:
 *   - `hero` — top-level field
 *   - `cards.image` — nested object field
 *   - `gallery[].image` — field inside an array's items
 *
 * Pure function — no I/O. Tested in isolation; the validator wraps it.
 */

interface JsonSchema {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  items?: JsonSchema | JsonSchema[]
  oneOf?: JsonSchema[]
  anyOf?: JsonSchema[]
  allOf?: JsonSchema[]
  assetOptions?: { altRequired?: boolean; [key: string]: unknown }
  [key: string]: unknown
}

/**
 * Return every JSON-pointer-style path within `schema` whose subschema has
 * `assetOptions.altRequired === true`. Paths join nested object keys with
 * `.`; array items are indicated by `[]`.
 */
export function findAltRequiredPaths(schema: unknown): string[] {
  const out: string[] = []
  walk(schema as JsonSchema, '', out)
  return out
}

function walk(schema: JsonSchema | undefined | null, path: string, out: string[]): void {
  if (!schema || typeof schema !== 'object') return

  // Hit on this node.
  if (schema.assetOptions?.altRequired === true) {
    out.push(path || '<root>')
    // Don't descend further — the embeddedAsset() shape is a leaf in walker
    // semantics. Anything below is the asset reference's own structure.
    return
  }

  // Object properties.
  if (schema.properties) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      walk(sub, path ? `${path}.${key}` : key, out)
    }
  }

  // Array items.
  if (schema.items) {
    const items = Array.isArray(schema.items) ? schema.items : [schema.items]
    for (const sub of items) {
      walk(sub, `${path}[]`, out)
    }
  }

  // Union schemas (oneOf / anyOf / allOf) — descend into every branch since
  // any branch could carry altRequired metadata.
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    const arr = schema[key]
    if (!Array.isArray(arr)) continue
    for (const sub of arr) walk(sub, path, out)
  }
}

/**
 * Read the values at a walker path within `value`. For array paths
 * (`gallery[].image`), returns one value per element.
 *
 * Symmetric with `findAltRequiredPaths` — paths produced by the walker are
 * resolvable here.
 */
export function readAtPath(value: unknown, path: string): unknown[] {
  return readEntriesAtPath(value, path).map(e => e.value)
}

/**
 * Like `readAtPath`, with each value's own path: the walker path with each
 * `[]` given its index (`gallery[1].image`), so two values in one array
 * field can be told apart (#1756).
 */
export function readEntriesAtPath(value: unknown, path: string): { value: unknown; path: string }[] {
  if (path === '<root>') return value === undefined ? [] : [{ value, path }]
  return resolve(value, parsePath(path), 0, '')
}

function parsePath(path: string): Array<{ kind: 'key'; name: string } | { kind: 'array' }> {
  const out: Array<{ kind: 'key'; name: string } | { kind: 'array' }> = []
  let i = 0
  while (i < path.length) {
    if (path[i] === '.') {
      i++
      continue
    }
    if (path[i] === '[' && path[i + 1] === ']') {
      out.push({ kind: 'array' })
      i += 2
      continue
    }
    let j = i
    while (j < path.length && path[j] !== '.' && path[j] !== '[') j++
    out.push({ kind: 'key', name: path.slice(i, j) })
    i = j
  }
  return out
}

function resolve(
  value: unknown,
  segments: ReturnType<typeof parsePath>,
  depth: number,
  at: string,
): { value: unknown; path: string }[] {
  if (depth === segments.length) {
    return value === undefined || value === null ? [] : [{ value, path: at }]
  }
  const seg = segments[depth]
  if (seg.kind === 'array') {
    if (!Array.isArray(value)) return []
    return value.flatMap((item, i) => resolve(item, segments, depth + 1, `${at}[${i}]`))
  }
  if (typeof value !== 'object' || value === null) return []
  const next = (value as Record<string, unknown>)[seg.name]
  return resolve(next, segments, depth + 1, at ? `${at}.${seg.name}` : seg.name)
}
