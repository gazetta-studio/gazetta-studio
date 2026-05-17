import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendEntry,
  emptySkipList,
  findSkipMatch,
  globMatches,
  readSkipList,
  type SkipEntry,
  type SkipList,
  type SkipRule,
  writeSkipList,
} from '../skip-list.js'

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'map-skip-list-test-'))
  path = resolve(dir, 'skip-list.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function entry(overrides: Partial<SkipEntry> = {}): SkipEntry {
  return {
    fingerprint: { path: 'packages/gazetta/src/foo.ts' },
    reason: 'never-mutate',
    reasonNote: 'generated code',
    addedAt: '2026-05-17T12:00:00Z',
    addedBy: 'bot',
    ...overrides,
  }
}

function rule(overrides: Partial<SkipRule> = {}): SkipRule {
  return {
    scope: 'packages/gazetta/src/generated/**/*.ts',
    reason: 'never-mutate',
    reasonNote: 'generated code',
    addedAt: '2026-05-17T12:00:00Z',
    addedBy: 'bot',
    ...overrides,
  }
}

describe('readSkipList / writeSkipList', () => {
  it('returns empty list when file is missing', () => {
    expect(readSkipList(path)).toEqual(emptySkipList())
  })

  it('round-trips a list with entries and rules', () => {
    const list: SkipList = { version: 1, entries: [entry()], rules: [rule()] }
    writeSkipList(path, list)
    expect(readSkipList(path)).toEqual(list)
  })

  it('returns empty list on malformed JSON', () => {
    writeSkipList(path, emptySkipList())
    // Corrupt the file
    require('node:fs').writeFileSync(path, 'not-json')
    expect(readSkipList(path)).toEqual(emptySkipList())
  })

  it('returns empty list when version is wrong', () => {
    require('node:fs').writeFileSync(path, JSON.stringify({ version: 2, entries: [], rules: [] }))
    expect(readSkipList(path)).toEqual(emptySkipList())
  })
})

describe('findSkipMatch', () => {
  it('returns null when nothing matches', () => {
    const list: SkipList = { version: 1, entries: [entry()], rules: [] }
    expect(findSkipMatch(list, { path: 'src/bar.ts' })).toBeNull()
  })

  it('matches entry by exact path', () => {
    const e = entry({ fingerprint: { path: 'src/foo.ts' } })
    const list: SkipList = { version: 1, entries: [e], rules: [] }
    expect(findSkipMatch(list, { path: 'src/foo.ts' })).toBe(e)
  })

  it('matches rule by glob', () => {
    const r = rule({ scope: 'src/generated/**/*.ts' })
    const list: SkipList = { version: 1, entries: [], rules: [r] }
    expect(findSkipMatch(list, { path: 'src/generated/api/types.ts' })).toBe(r)
  })

  it('entry match wins over rule match (more specific)', () => {
    const e = entry({ fingerprint: { path: 'src/foo.ts' }, reasonNote: 'specific' })
    const r = rule({ scope: 'src/**/*.ts', reasonNote: 'general' })
    const list: SkipList = { version: 1, entries: [e], rules: [r] }
    expect(findSkipMatch(list, { path: 'src/foo.ts' })).toBe(e)
  })
})

describe('globMatches', () => {
  it('matches exact paths', () => {
    expect(globMatches('src/foo.ts', 'src/foo.ts')).toBe(true)
    expect(globMatches('src/foo.ts', 'src/bar.ts')).toBe(false)
  })

  it('* matches single segment', () => {
    expect(globMatches('src/*.ts', 'src/foo.ts')).toBe(true)
    expect(globMatches('src/*.ts', 'src/foo/bar.ts')).toBe(false)
  })

  it('** matches any depth', () => {
    expect(globMatches('src/**/*.ts', 'src/foo.ts')).toBe(true)
    expect(globMatches('src/**/*.ts', 'src/admin-api/routes/publish.ts')).toBe(true)
  })

  it('escapes regex special chars literally', () => {
    // Dots in the pattern must match dots, not any character
    expect(globMatches('src/foo.ts', 'src/fooXts')).toBe(false)
  })
})

describe('appendEntry', () => {
  it('adds a new entry and returns true', () => {
    const list = emptySkipList()
    expect(appendEntry(list, entry())).toBe(true)
    expect(list.entries).toHaveLength(1)
  })

  it('refuses to add a duplicate path and returns false', () => {
    const list = emptySkipList()
    appendEntry(list, entry())
    expect(appendEntry(list, entry({ reasonNote: 'different note' }))).toBe(false)
    expect(list.entries).toHaveLength(1)
  })
})
