/**
 * unreadable-schema (design-content-trust.md Q2): a template whose schema
 * can't be converted fails to render, so the background scan names it, once
 * per item, before anyone publishes.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createContentRoot } from '../src/content-root.js'
import { unreadableSchema } from '../src/validation/validators/unreadable-schema.js'
import type { ValidatorInput } from '../src/validation/types.js'
import { memoryStorage } from './_helpers/memory-storage.js'

let templatesDir: string
beforeAll(async () => {
  const tmp = resolve(__dirname, '../../../.tmp')
  await mkdir(tmp, { recursive: true })
  templatesDir = join(await mkdtemp(join(tmp, 'unreadable-schema-')), 'templates')
  const write = async (name: string, source: string) => {
    await mkdir(join(templatesDir, name), { recursive: true })
    await writeFile(join(templatesDir, name, 'index.ts'), source)
  }
  await write(
    'us-broken',
    "export const schema = { notZod: true }\nexport default () => ({ html: '', css: '', js: '' })\n",
  )
  await write(
    'us-fine',
    "import { z } from 'zod'\nexport const schema = z.object({ when: z.date() })\nexport default () => ({ html: '', css: '', js: '' })\n",
  )
  await write('us-throws', "throw new Error('boom')\n")
})
afterAll(async () => {
  await rm(resolve(templatesDir, '..'), { recursive: true, force: true })
})

function scan(templates: string[], stage: ValidatorInput['stage'] = 'background') {
  const storage = memoryStorage()
  const manifest = {
    template: templates[0],
    content: {},
    components: templates.slice(1).map((template, i) => ({ name: `c${i}`, template, content: {} })),
  }
  return unreadableSchema.validate({
    stage,
    site: { templatesDir } as never,
    contentRoot: createContentRoot(storage, ''),
    storage,
    scope: { kind: 'background', item: { kind: 'page', name: 'home', itemPath: 'pages/home/page.json' }, manifest },
  } as ValidatorInput)
}

describe('unreadable-schema', () => {
  it('names a template whose schema cannot be read, once per item however many components use it', async () => {
    const issues = await scan(['us-fine', 'us-broken', 'us-broken'])
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({
      validator: 'unreadable-schema',
      severity: 'error',
      itemPath: 'pages/home/page.json',
      subject: 'us-broken',
    })
    expect(issues[0].message).toMatch(/^Template "us-broken": its schema can't be read, so this page won't render\. \S/)
  })

  it('reports nothing for readable schemas, including ones with unrepresentable fields', async () => {
    expect(await scan(['us-fine', 'us-fine'])).toEqual([])
  })

  it('leaves missing templates and templates that fail to load to other validators', async () => {
    expect(await scan(['no-such-template', 'us-throws'])).toEqual([])
  })

  it('runs only in the background scan', () => {
    expect(unreadableSchema.stages).toEqual(['background'])
  })
})
