import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { reactive } from 'vue'
import { plainCopy } from '../src/client/utils/plainCopy.js'

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(ts|vue)$/.test(entry) ? [path] : []
  })
}

describe('plainCopy', () => {
  it('is the only JSON deep copy in the admin source', () => {
    const src = join(__dirname, '../src')
    const hits = sourceFiles(src).filter(f => readFileSync(f, 'utf8').includes('JSON.parse(JSON.stringify'))
    expect(hits.map(f => f.slice(src.length + 1))).toEqual(['client/utils/plainCopy.ts'])
  })

  it('returns a copy that structuredClone accepts, detached from a reactive source', () => {
    const source = reactive({ title: 'a', nested: { items: [1, 2] } })
    const copy = plainCopy(source)
    expect(() => structuredClone(copy)).not.toThrow()
    copy.nested.items.push(3)
    expect(source.nested.items).toEqual([1, 2])
    expect(copy).toEqual({ title: 'a', nested: { items: [1, 2, 3] } })
  })
})
