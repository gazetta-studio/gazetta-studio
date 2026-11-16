/**
 * `script-in-text` (design-content-trust.md Q2, Q3): script and unsafe
 * addresses in fields templates insert as plain text are refused at save and
 * listed in Site health; Markdown, rich text and code fields are left to the
 * sanitizer or shown as code.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createContentRoot } from '../src/content-root.js'
import { scriptInText } from '../src/validation/validators/script-in-text.js'
import type { ValidatorInput } from '../src/validation/types.js'
import type { PageManifest } from '../src/types.js'
import { memoryStorage } from './_helpers/memory-storage.js'

const ARTICLE = `import { z } from 'zod'
export const schema = z.object({
  title: z.string().meta({ title: 'Title' }).optional(),
  link: z.string().optional(),
  body: z.string().meta({ format: 'markdown' }).optional(),
  rich: z.string().meta({ format: 'richtext' }).optional(),
  snippet: z.string().meta({ format: 'code' }).optional(),
  file: z.string().meta({ format: 'data-url' }).optional(),
  cta: z.object({ label: z.string() }).optional(),
  tags: z.array(z.string()).meta({ title: 'Tags' }).optional(),
  items: z.array(z.object({ href: z.string() })).optional(),
})
export default () => ({ html: '', css: '', js: '' })
`

let templatesDir: string
beforeAll(async () => {
  const tmp = resolve(__dirname, '../../../.tmp')
  await mkdir(tmp, { recursive: true })
  templatesDir = join(await mkdtemp(join(tmp, 'script-in-text-')), 'templates')
  await mkdir(join(templatesDir, 'sit-article'), { recursive: true })
  await writeFile(join(templatesDir, 'sit-article', 'index.ts'), ARTICLE)
})
afterAll(async () => {
  await rm(resolve(templatesDir, '..'), { recursive: true, force: true })
})

const item = { kind: 'page' as const, name: 'home', itemPath: 'pages/home/page.json' }
const page = (content: Record<string, unknown>): PageManifest =>
  ({ template: 'page-default', content: {}, components: [{ name: 'a', template: 'sit-article', content }] }) as never

function input(scope: ValidatorInput['scope']): ValidatorInput {
  const storage = memoryStorage()
  return {
    stage: scope.kind as ValidatorInput['stage'],
    site: { templatesDir } as never,
    contentRoot: createContentRoot(storage, ''),
    storage,
    scope,
  }
}
const save = (after: Record<string, unknown>, before: Record<string, unknown> | null = null) =>
  scriptInText.validate(input({ kind: 'save-delta', item, before: before ? page(before) : null, after: page(after) }))
const scan = (content: Record<string, unknown>) =>
  scriptInText.validate(input({ kind: 'background', item, manifest: page(content) }))

describe('script-in-text at save', () => {
  it('refuses an event handler in a plain text field, naming the field and what to remove', async () => {
    const issues = await save({ title: '<img src=x onerror=alert(1)>' })
    expect(issues).toEqual([
      {
        validator: 'script-in-text',
        severity: 'error',
        message: "Script isn't allowed in Title: remove onerror.",
        itemPath: 'pages/home/page.json',
        contentPath: 'a',
        field: 'title',
        subject: 'onerror',
      },
    ])
  })

  it('refuses a script element', async () => {
    const [issue] = await save({ link: 'hi <script>x()</script>' })
    expect(issue).toMatchObject({ message: "Script isn't allowed in link: remove <script>.", subject: '<script>' })
  })

  it.each(['a < b', '<b>bold</b>', 'https://example.com', 'Notes: see below'])('lets %j save', async value => {
    expect(await save({ title: value })).toEqual([])
  })

  it.each([
    ['javascript:alert(1)', 'javascript:'],
    ['JaVaScRiPt:x', 'javascript:'],
    ['java\tscript:x', 'javascript:'],
    ['&#106;avascript:x', 'javascript:'],
    [' \u0001javascript:x', 'javascript:'],
    ['vbscript:x', 'vbscript:'],
    ['data:text/html,<script>', 'data:'],
    ['data:image/svg+xml;base64,PHN2Zz4=', 'data:'],
  ])('refuses the unsafe address %j', async (value, what) => {
    const [issue] = await save({ link: value })
    expect(issue).toMatchObject({ message: `Script isn't allowed in link: remove ${what}.`, subject: what })
  })

  it.each(['data:image/png;base64,AAAA', 'data:image/avif;base64,AAAA', 'data:image/webp,%3Csvg'])(
    'lets the raster data image %j save',
    async value => {
      expect(await save({ link: value })).toEqual([])
    },
  )

  it('skips Markdown and rich-text fields: the sanitizer handles them', async () => {
    expect(await save({ body: '<script>x()</script>', rich: '<a href="javascript:x" onclick=y>z</a>' })).toEqual([])
  })

  it('never refuses a code field', async () => {
    expect(await save({ snippet: '<script>alert(1)</script>' })).toEqual([])
  })

  it.each([
    ['data:application/pdf;name=a.pdf;base64,AAAA', null],
    ['data:application/pdf;base64,AAAA', null],
    ['javascript:alert(1)', 'javascript:'],
    ['report.pdf', 'report.pdf'],
  ])('checks the shape of file field value %j', async (value, what) => {
    const issues = await save({ file: value })
    if (what === null) expect(issues).toEqual([])
    else expect(issues[0]).toMatchObject({ field: 'file', subject: what })
  })

  it('finds script in a nested object field and in list items, naming the field', async () => {
    const issues = await save({
      cta: { label: '<svg onload=x>' },
      tags: ['ok', '<img src=x onerror=y>'],
      items: [{ href: 'javascript:x' }],
    })
    expect(issues.map(i => [i.field, i.message])).toEqual([
      ['cta.label', "Script isn't allowed in label: remove onload."],
      ['tags.1', "Script isn't allowed in Tags: remove onerror."],
      ['items.0.href', "Script isn't allowed in href: remove javascript:."],
    ])
  })

  it('only refuses what the save adds: script already stored saves when another field is edited', async () => {
    const before = { title: '<img src=x onerror=y>', link: 'a' }
    expect(await save({ ...before, link: 'b' }, before)).toEqual([])
    const issues = await save({ ...before, link: 'javascript:x' }, before)
    expect(issues.map(i => i.field)).toEqual(['link'])
  })

  it('refuses script in a new item', async () => {
    expect(await save({ title: '<script>x</script>' }, null)).toHaveLength(1)
  })

  it('leaves a component whose template is missing to other validators', async () => {
    const after = {
      template: 'page-default',
      content: {},
      components: [{ name: 'x', template: 'nope', content: { t: '<script>' } }],
    }
    const issues = await scriptInText.validate(input({ kind: 'save-delta', item, before: null, after: after as never }))
    expect(issues).toEqual([])
  })
})

describe('script-in-text in the background scan', () => {
  it('lists every value holding script as an error, with Site health wording', async () => {
    const [issue] = await scan({ title: '<img src=x onerror=y>' })
    expect(issue).toMatchObject({
      severity: 'error',
      message: 'Title holds script (onerror). Remove it before the next save of this field.',
      field: 'title',
      contentPath: 'a',
    })
  })

  it('reports a code field holding script as info', async () => {
    const [issue] = await scan({ snippet: '<script>alert(1)</script>' })
    expect(issue).toMatchObject({
      severity: 'info',
      message: 'snippet holds script (<script>). It shows as code only if the template escapes it.',
      subject: '<script>',
    })
  })

  it('reports nothing for clean content', async () => {
    expect(await scan({ title: 'Hello', body: '<script>x</script>', snippet: 'const a = 1' })).toEqual([])
  })
})
