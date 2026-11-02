/** #1750: two folders' same-named templates load apart; invalidating a name clears both. */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { invalidateTemplate, loadTemplate } from '../src/template-loader.js'
import { tempDir } from './_helpers/temp.js'

const root = tempDir(`loader-folders-${Date.now()}-${Math.random().toString(36).slice(2)}`)
function folder(name: string, text: string): string {
  const dir = join(root, name, 'templates')
  mkdirSync(join(dir, 'hero'), { recursive: true })
  writeFileSync(
    join(dir, 'hero/index.ts'),
    `export const schema = { safeParse: () => ({ success: true }) }\nexport default () => ({ html: '${text}', css: '', js: '' })\n`,
  )
  return dir
}

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('loadTemplate across templates folders', () => {
  it("keeps two folders' hero apart", async () => {
    const head = folder('head', 'head hero')
    const base = folder('base', 'base hero')
    const fromHead = await loadTemplate(undefined, head, 'hero')
    const fromBase = await loadTemplate(undefined, base, 'hero')
    expect((fromHead.render as () => { html: string })().html).toBe('head hero')
    expect((fromBase.render as () => { html: string })().html).toBe('base hero')
    expect(await loadTemplate(undefined, head, 'hero')).toBe(fromHead)
  })

  it('invalidating a name reloads it in every folder', async () => {
    const dir = folder('reload', 'before')
    const first = await loadTemplate(undefined, dir, 'hero')
    invalidateTemplate('hero')
    expect(await loadTemplate(undefined, dir, 'hero')).not.toBe(first)
  })
})
