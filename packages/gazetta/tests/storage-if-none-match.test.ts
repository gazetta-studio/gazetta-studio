/**
 * Create-if-absent writes (#1554): with `ifNoneMatch: '*'`, `writeFile`
 * creates a file only when it doesn't exist, in one step, and leaves an
 * existing file unchanged. MinIO and Azurite run the same checks in the
 * provider conformance suite (apps/admin/tests/_helpers/provider-conformance.ts).
 */
import { readdir, rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { StorageConditionalFailedError } from '../src/storage-errors.js'
import type { StorageProvider } from '../src/types.js'
import { memoryStorage } from './_helpers/memory-storage.js'
import { tempDir } from './_helpers/temp.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

function filesystem(): StorageProvider {
  const dir = tempDir(`if-none-match-${Math.random().toString(36).slice(2)}`)
  dirs.push(dir)
  return createFilesystemProvider(dir)
}

describe.each([
  ['filesystem', filesystem],
  ['memory', () => memoryStorage()],
] as const)('%s storage: writeFile with ifNoneMatch', (_name, make) => {
  it('creates a file that does not exist', async () => {
    const storage = make()
    await storage.writeFile('locks/a.json', 'first', { ifNoneMatch: '*' })
    expect(await storage.readFile('locks/a.json')).toBe('first')
  })

  it('refuses an existing file and leaves it unchanged', async () => {
    const storage = make()
    await storage.writeFile('locks/a.json', 'first')
    const err = await storage.writeFile('locks/a.json', 'second', { ifNoneMatch: '*' }).catch(e => e)
    expect(err).toBeInstanceOf(StorageConditionalFailedError)
    expect(err.path).toBe('locks/a.json')
    expect(await storage.readFile('locks/a.json')).toBe('first')
  })

  it('lets exactly one of many concurrent writers create the file', async () => {
    const storage = make()
    const writers = Array.from({ length: 20 }, (_, i) => `writer-${i}`)
    const results = await Promise.allSettled(
      writers.map(w => storage.writeFile('locks/race.json', w, { ifNoneMatch: '*' })),
    )
    const won = results.flatMap((r, i) => (r.status === 'fulfilled' ? [writers[i]] : []))
    expect(won).toHaveLength(1)
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(StorageConditionalFailedError)
    }
    expect(await storage.readFile('locks/race.json')).toBe(won[0])
  })

  it('overwrites as before without the option', async () => {
    const storage = make()
    await storage.writeFile('page.json', 'first')
    await storage.writeFile('page.json', 'second')
    expect(await storage.readFile('page.json')).toBe('second')
  })
})

describe('filesystem storage: create-if-absent leaves no temp files', () => {
  it('after a win and a refusal', async () => {
    const storage = filesystem()
    await storage.writeFile('locks/a.json', 'first', { ifNoneMatch: '*' })
    await storage.writeFile('locks/a.json', 'second', { ifNoneMatch: '*' }).catch(() => {})
    expect(await readdir(`${storage.root}/locks`)).toEqual(['a.json'])
  })
})
