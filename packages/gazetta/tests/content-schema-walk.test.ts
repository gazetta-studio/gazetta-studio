/** The schema walk processContent and the script-in-text check share (design-content-trust.md Q2). */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  contentJsonSchema,
  mapContentStrings,
  UnreadableSchemaError,
  type ContentString,
} from '../src/content-schema-walk.js'

const md = z.string().meta({ format: 'markdown' })
const code = z.string().meta({ format: 'code' })

function visit(schema: z.ZodType, content: unknown): Array<[string, string, string[], string | undefined]> {
  const out: ContentString[] = []
  mapContentStrings(content, contentJsonSchema(schema), s => {
    out.push(s)
    return s.value
  })
  return out.map(s => [s.path.join('.'), s.value, [...s.formats].sort(), s.label])
}

describe('mapContentStrings', () => {
  it('yields each string with its path, formats and label through objects and arrays', () => {
    const schema = z.object({
      title: z.string().meta({ title: 'Title' }),
      body: md,
      cta: z.object({ label: z.string() }),
      tags: z.array(z.string()).meta({ title: 'Tags' }),
      items: z.array(z.object({ snippet: code })),
    })
    expect(
      visit(schema, {
        title: 't',
        body: 'b',
        cta: { label: 'l' },
        tags: ['x'],
        items: [{ snippet: 's' }],
      }),
    ).toEqual([
      ['title', 't', [], 'Title'],
      ['body', 'b', ['markdown'], 'Body'],
      ['cta.label', 'l', [], 'Label'],
      ['tags.0', 'x', [], 'Tags'],
      ['items.0.snippet', 's', ['code'], 'Snippet'],
    ])
  })

  it('follows tuples, unions, records and recursive $refs', () => {
    type Node = { text: string; children?: Node[] }
    const node: z.ZodType<Node> = z.lazy(() => z.object({ text: md, children: z.array(node).optional() }))
    const schema = z.object({
      pair: z.tuple([z.string(), code]),
      either: z.union([z.number(), md]),
      map: z.record(z.string(), code),
      tree: node,
    })
    const found = visit(schema, {
      pair: ['a', 'b'],
      either: 'c',
      map: { k: 'd' },
      tree: { text: 'e', children: [{ text: 'f' }] },
    })
    expect(found.map(([path, , formats]) => [path, formats])).toEqual([
      ['pair.0', []],
      ['pair.1', ['code']],
      ['either', ['markdown']],
      ['map.k', ['code']],
      ['tree.text', ['markdown']],
      ['tree.children.0.text', ['markdown']],
    ])
  })

  it('rebuilds the content with what fn returns', () => {
    const root = contentJsonSchema(z.object({ a: z.string(), n: z.number() }))
    const out = mapContentStrings({ a: 'x', n: 1 }, root, s => s.value.toUpperCase())
    expect(out).toEqual({ a: 'X', n: 1 })
  })

  it('passes strings no schema describes to fn with no formats, at any depth', () => {
    const schema = z.object({ any: z.any(), loose: z.record(z.string(), z.unknown()) })
    const found = visit(schema, {
      any: { links: [{ href: 'h' }] },
      loose: { nested: { title: 't' } },
      extra: 'e',
    })
    expect(found).toEqual([
      ['any.links.0.href', 'h', [], 'Href'],
      ['loose.nested.title', 't', [], 'Title'],
      ['extra', 'e', [], 'Extra'],
    ])
  })
})

describe('contentJsonSchema', () => {
  it('throws UnreadableSchemaError naming the template when the schema cannot be converted', () => {
    let error: unknown
    try {
      contentJsonSchema({ notZod: true }, 'broken')
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(UnreadableSchemaError)
    expect((error as UnreadableSchemaError).templateName).toBe('broken')
    expect((error as UnreadableSchemaError).message).toMatch(/Template "broken": its schema can't be read/)
  })

  it('converts once per schema object', () => {
    const schema = z.object({ a: z.string() })
    expect(contentJsonSchema(schema)).toBe(contentJsonSchema(schema))
  })
})
