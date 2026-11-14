import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { processContent } from '../src/content.js'
import { format } from '../src/formats.js'

describe('processContent', () => {
  it('converts markdown fields to HTML', () => {
    const schema = z.object({
      body: z.string().meta(format.markdown()),
    })
    const content = { body: '# Hello\n\nThis is **bold**.' }
    const result = processContent(content, schema)
    expect(result?.body).toContain('<h1>Hello</h1>')
    expect(result?.body).toContain('<strong>bold</strong>')
  })

  it('leaves non-markdown fields unchanged', () => {
    const schema = z.object({
      title: z.string(),
      body: z.string().meta(format.markdown()),
    })
    const content = { title: '# Not markdown', body: '# Is markdown' }
    const result = processContent(content, schema)
    expect(result?.title).toBe('# Not markdown')
    expect(result?.body).toContain('<h1>Is markdown</h1>')
  })

  it('handles undefined content', () => {
    const schema = z.object({ body: z.string() })
    expect(processContent(undefined, schema)).toBeUndefined()
  })

  it('handles undefined schema', () => {
    const content = { body: '# Hello' }
    expect(processContent(content, undefined)).toEqual(content)
  })

  it('handles GFM tables', () => {
    const schema = z.object({ body: z.string().meta(format.markdown()) })
    const content = { body: '| A | B |\n|---|---|\n| 1 | 2 |' }
    const result = processContent(content, schema)
    expect(result?.body).toContain('<table>')
    expect(result?.body).toContain('<td>1</td>')
  })

  it('handles GFM strikethrough', () => {
    const schema = z.object({ body: z.string().meta(format.markdown()) })
    const content = { body: '~~deleted~~' }
    const result = processContent(content, schema)
    expect(result?.body).toContain('<del>deleted</del>')
  })

  it('handles code blocks', () => {
    const schema = z.object({ body: z.string().meta(format.markdown()) })
    const content = { body: '```ts\nconst x = 1\n```' }
    const result = processContent(content, schema)
    expect(result?.body).toContain('<code')
    expect(result?.body).toContain('const x = 1')
  })
})

describe('format helpers', () => {
  it('format.markdown() produces correct meta', () => {
    expect(format.markdown()).toEqual({ format: 'markdown' })
  })

  it('format.textarea() produces correct meta with options', () => {
    expect(format.textarea({ rows: 5 })).toEqual({ format: 'textarea', rows: 5 })
  })

  it('format.color() produces correct meta', () => {
    expect(format.color()).toEqual({ format: 'color' })
  })

  it('format meta flows through to JSON Schema', () => {
    const schema = z.object({
      body: z.string().meta(format.markdown()),
      color: z.string().meta(format.color()),
    })
    const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>
    const props = jsonSchema.properties as Record<string, Record<string, unknown>>
    expect(props.body.format).toBe('markdown')
    expect(props.color.format).toBe('color')
  })
})

describe('processContent sanitizing', () => {
  const md = z.object({ body: z.string().meta(format.markdown()) })
  const rich = z.object({ body: z.string().meta(format.richtext()) })

  it.each([
    ['script', '<script>alert(1)</script>', /<script|alert\(1\)/, ''],
    ['event handler', '<img src="/a.png" onerror="alert(1)">', /onerror/, '<img src="/a.png">'],
    [
      'form and controls',
      '<form action="/x"><input name="a"><select><option>o</option></select><textarea>t</textarea></form>',
      /<form|<input|<select|<option|<textarea|action=/,
      '',
    ],
    ['iframe', '<iframe src="https://evil.test"></iframe>', /<iframe/, ''],
    ['object and embed', '<object data="x"></object><embed src="y">', /<object|<embed/, ''],
    ['style element', '<style>body{display:none}</style>', /<style|display:none/, ''],
    ['style attribute', '<p style="position:fixed">x</p>', /style=/, '<p>x</p>'],
  ])('removes %s from Markdown fields', (_name, input, forbidden, kept) => {
    const result = processContent({ body: `# Title\n\n<p>before</p>\n${input}\n<p>after</p>` }, md)
    expect(result?.body).not.toMatch(forbidden)
    expect(result?.body).toContain('<h1>Title</h1>')
    expect(result?.body).toContain('<p>before</p>')
    expect(result?.body).toContain('<p>after</p>')
    if (kept) expect(result?.body).toContain(kept)
  })

  it('keeps headings, emphasis, links and images in Markdown', () => {
    const result = processContent({ body: '## Sub\n\n*em* **strong** [link](/about) ![alt](/a.png)' }, md)
    expect(result?.body).toContain('<h2>Sub</h2>')
    expect(result?.body).toContain('<em>em</em>')
    expect(result?.body).toContain('<strong>strong</strong>')
    expect(result?.body).toContain('<a href="/about">link</a>')
    expect(result?.body).toContain('<img src="/a.png" alt="alt">')
  })

  it('removes javascript: links', () => {
    const result = processContent({ body: '[x](javascript:alert(1))' }, md)
    expect(result?.body).not.toContain('javascript:')
  })

  it('sanitizes rich-text HTML and keeps target, rel, dir and bdi', () => {
    const body =
      '<p dir="rtl" onclick="x()">a <bdi>b</bdi> <a href="/x" target="_blank" rel="noopener">l</a></p><script>bad()</script>'
    const result = processContent({ body }, rich)
    expect(result?.body).toBe('<p dir="rtl">a <bdi>b</bdi> <a href="/x" target="_blank" rel="noopener">l</a></p>')
  })

  it.each([
    ['drops rel=opener', '<a href="/x" rel="opener">l</a>', '<a href="/x">l</a>'],
    [
      'drops opener but keeps other rel tokens',
      '<a href="/x" rel="nofollow opener">l</a>',
      '<a href="/x" rel="nofollow">l</a>',
    ],
    [
      'adds noopener to target=_blank',
      '<a href="/x" target="_blank" rel="opener">l</a>',
      '<a href="/x" target="_blank" rel="noopener">l</a>',
    ],
    [
      'adds noopener to a named target',
      '<a href="/x" target="win">l</a>',
      '<a href="/x" target="win" rel="noopener">l</a>',
    ],
    [
      'reads attribute values containing > and tag-like text',
      '<a title="a > <a rel=opener>" href="/x" rel="opener" target="_blank">l</a>',
      '<a title="a &gt; &lt;a rel=opener&gt;" href="/x" target="_blank" rel="noopener">l</a>',
    ],
    ['leaves target=_self alone', '<a href="/x" target="_self">l</a>', '<a href="/x" target="_self">l</a>'],
  ])('rich-text links: %s', (_name, body, expected) => {
    expect(processContent({ body }, rich)?.body).toBe(`${expected}`)
  })

  it('does not convert rich-text fields as Markdown', () => {
    expect(processContent({ body: '# not a heading' }, rich)?.body).toBe('# not a heading')
  })

  it('leaves plain text fields unchanged', () => {
    const schema = z.object({ title: z.string() })
    expect(processContent({ title: '<b>x</b>' }, schema)?.title).toBe('<b>x</b>')
  })

  it('converts and sanitizes Markdown nested in objects and array items', () => {
    const schema = z.object({
      card: z.object({ text: z.string().meta(format.markdown()) }),
      items: z.array(z.object({ text: z.string().meta(format.markdown()), label: z.string() })),
    })
    const result = processContent(
      {
        card: { text: '**card**<script>x()</script>' },
        items: [
          { text: '*one*', label: '*label*' },
          { text: '<img src="/i.png" onerror="y()">', label: 'two' },
        ],
      },
      schema,
    ) as { card: { text: string }; items: { text: string; label: string }[] }
    expect(result.card.text).toContain('<strong>card</strong>')
    expect(result.card.text).not.toContain('<script')
    expect(result.items[0].text).toContain('<em>one</em>')
    expect(result.items[0].label).toBe('*label*')
    expect(result.items[1].text).not.toContain('onerror')
  })

  it('handles optional and nullable Markdown fields', () => {
    const schema = z.object({ body: z.string().meta(format.markdown()).nullable().optional() })
    expect(processContent({ body: '*x*' }, schema)?.body).toContain('<em>x</em>')
    expect(processContent({ body: null }, schema)?.body).toBeNull()
    expect(processContent({}, schema)).toEqual({})
  })

  it('follows recursive schemas', () => {
    type Node = { text: string; kids: Node[] }
    const NodeSchema: z.ZodType<Node> = z.object({
      text: z.string().meta(format.markdown()),
      get kids() {
        return z.array(NodeSchema)
      },
    })
    const result = processContent({ text: 'a', kids: [{ text: '*deep*<script>z()</script>', kids: [] }] }, NodeSchema)
    const kid = (result?.kids as Node[])[0]
    expect(kid.text).toContain('<em>deep</em>')
    expect(kid.text).not.toContain('<script')
  })

  it('keeps rendering schemas with z.date, .transform, z.custom and z.bigint fields', () => {
    const schema = z.object({
      when: z.date(),
      count: z.string().transform(s => s.length),
      custom: z.custom<string>(() => true),
      big: z.bigint(),
      body: z.string().meta(format.markdown()),
    })
    const result = processContent(
      { when: 'w', count: 'c', custom: 'u', big: 'b', body: '*x*<script>s()</script>' },
      schema,
    )
    expect(result?.body).toContain('<em>x</em>')
    expect(result?.body).not.toContain('<script')
    expect(result?.when).toBe('w')
  })

  it('throws, naming the template, when the schema cannot be read', () => {
    expect(() => processContent({ body: '<script>x()</script>' }, { notZod: true }, 'broken-hero')).toThrow(
      /Template "broken-hero".*can't be read/,
    )
  })
})

describe('processContent finds Markdown fields in every schema shape', () => {
  const md = z.string().meta(format.markdown())
  const XSS = '*safe*<img src="/x.png" onerror="alert(1)"><script>s()</script>'
  const expectSanitized = (html: unknown) => {
    expect(html).toContain('<em>safe</em>')
    expect(html).toContain('<img src="/x.png">')
    expect(html).not.toMatch(/onerror|<script|s\(\)/)
  }

  it('sanitizes record values (additionalProperties)', () => {
    const schema = z.object({ title: z.string(), byKey: z.record(z.string(), md) })
    const result = processContent({ title: '<b>t</b>', byKey: { a: XSS, b: XSS } }, schema) as {
      title: string
      byKey: Record<string, string>
    }
    expectSanitized(result.byKey.a)
    expectSanitized(result.byKey.b)
    expect(result.title).toBe('<b>t</b>')
  })

  it('sanitizes catchall values but leaves declared plain fields', () => {
    const schema = z.object({ title: z.string() }).catchall(md)
    const result = processContent({ title: '<b>t</b>', extra: XSS }, schema)
    expectSanitized(result?.extra)
    expect(result?.title).toBe('<b>t</b>')
  })

  it('sanitizes tuple elements (prefixItems)', () => {
    const schema = z.object({ pair: z.tuple([z.string(), md]) })
    const result = processContent({ pair: ['<b>plain</b>', XSS] }, schema) as { pair: string[] }
    expect(result.pair[0]).toBe('<b>plain</b>')
    expectSanitized(result.pair[1])
  })

  it('sanitizes a field in a later union branch', () => {
    const schema = z.object({
      block: z.union([z.object({ label: z.string() }), z.object({ body: md })]),
    })
    const result = processContent({ block: { body: XSS } }, schema) as { block: { body: string } }
    expectSanitized(result.block.body)
    const plain = processContent({ block: { label: '<b>l</b>' } }, schema) as { block: { label: string } }
    expect(plain.block.label).toBe('<b>l</b>')
  })

  it('sanitizes a Markdown field with a .transform()', () => {
    const schema = z.object({ body: md.transform(s => s.trim()), title: z.string() })
    const result = processContent({ body: XSS, title: '<b>t</b>' }, schema)
    expectSanitized(result?.body)
    expect(result?.title).toBe('<b>t</b>')
  })

  it('handles a schema that refers to itself through a union', () => {
    const Y: z.ZodType = z.lazy(() => z.union([md, Y]))
    const result = processContent({ y: XSS }, z.object({ y: Y }))
    expectSanitized(result?.y)
  })
})
