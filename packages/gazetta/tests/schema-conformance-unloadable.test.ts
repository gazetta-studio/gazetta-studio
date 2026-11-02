/** #1665: a template that exists but won't load is reported once per item that uses it. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { schemaConformance } from '../src/validation/validators/schema-conformance.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { createContentRoot } from '../src/content-root.js'
import { tempDir } from './_helpers/temp.js'
import type { ValidatorInput } from '../src/validation/types.js'

describe('schema-conformance: a template that fails to load (#1665)', () => {
  const dir = tempDir(`schema-unloadable-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const templatesDir = join(dir, 'templates')

  beforeAll(async () => {
    await mkdir(join(templatesDir, 'hero'), { recursive: true })
    await writeFile(join(templatesDir, 'hero/index.ts'), "throw new Error('hero is broken')\n")
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('gives an item one error, however many of its components use the template', async () => {
    const storage = createFilesystemProvider()
    const manifest = {
      template: 'page-default',
      route: '/',
      components: [
        { name: 'a', template: 'hero', content: {} },
        { name: 'b', template: 'hero', content: {} },
        { name: 'missing', template: 'no-such-template', content: {} },
      ],
    }
    const input = {
      stage: 'background',
      site: { templatesDir } as never,
      contentRoot: createContentRoot(storage, dir),
      storage,
      scope: { kind: 'background', item: { kind: 'page', name: 'home', itemPath: 'pages/home/page.json' }, manifest },
    } as unknown as ValidatorInput
    const issues = await schemaConformance.validate(input)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ severity: 'error', itemPath: 'pages/home/page.json' })
    expect(issues[0].message).toContain('Template "hero" couldn\'t be loaded')
    expect(issues[0].message).toContain('hero is broken')
  })
})
