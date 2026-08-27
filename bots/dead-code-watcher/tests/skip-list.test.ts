import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendEntry,
  emptySkipList,
  findSkipMatch,
  fingerprintsEqual,
  formatFingerprint,
  globMatches,
  readSkipList,
  type SkipList,
  writeSkipList,
} from '../skip-list.js'

describe('globMatches', () => {
  it('matches exact paths', () => {
    expect(globMatches('packages/foo/bar.ts', 'packages/foo/bar.ts')).toBe(true)
    expect(globMatches('packages/foo/bar.ts', 'packages/foo/baz.ts')).toBe(false)
  })

  it('matches single-segment wildcards', () => {
    expect(globMatches('packages/*/bar.ts', 'packages/foo/bar.ts')).toBe(true)
    expect(globMatches('packages/*/bar.ts', 'packages/foo/baz/bar.ts')).toBe(false)
    expect(globMatches('packages/foo/*.ts', 'packages/foo/anything.ts')).toBe(true)
  })

  it('matches deep wildcards', () => {
    expect(globMatches('packages/**/bar.ts', 'packages/foo/bar.ts')).toBe(true)
    expect(globMatches('packages/**/bar.ts', 'packages/foo/sub/bar.ts')).toBe(true)
    expect(globMatches('packages/**/bar.ts', 'packages/bar.ts')).toBe(true) // `**/` collapses to nothing
    expect(globMatches('packages/**', 'packages/foo/anything/here.ts')).toBe(true)
  })

  it('respects literal regex metacharacters in patterns', () => {
    expect(globMatches('packages/foo+bar.ts', 'packages/foo+bar.ts')).toBe(true)
    expect(globMatches('packages/foo+bar.ts', 'packages/fooxbar.ts')).toBe(false)
  })

  it('does not match across segment boundaries with single *', () => {
    expect(globMatches('packages/*.ts', 'packages/sub/file.ts')).toBe(false)
  })
})

describe('fingerprintsEqual', () => {
  it('matches same kind+path+symbol', () => {
    expect(
      fingerprintsEqual(
        { kind: 'export', path: 'src/foo.ts', symbol: 'bar' },
        { kind: 'export', path: 'src/foo.ts', symbol: 'bar' },
      ),
    ).toBe(true)
  })

  it('differs on kind', () => {
    expect(
      fingerprintsEqual(
        { kind: 'export', path: 'src/foo.ts', symbol: 'bar' },
        { kind: 'type', path: 'src/foo.ts', symbol: 'bar' },
      ),
    ).toBe(false)
  })

  it('differs on path', () => {
    expect(fingerprintsEqual({ kind: 'file', path: 'a.ts' }, { kind: 'file', path: 'b.ts' })).toBe(false)
  })

  it('differs when one has symbol and other does not', () => {
    expect(
      fingerprintsEqual({ kind: 'export', path: 'src/foo.ts', symbol: 'bar' }, { kind: 'export', path: 'src/foo.ts' }),
    ).toBe(false)
  })
})

describe('formatFingerprint', () => {
  it('formats file findings without symbol', () => {
    expect(formatFingerprint({ kind: 'file', path: 'src/foo.ts' })).toBe('file:src/foo.ts')
  })

  it('formats export findings with symbol after #', () => {
    expect(formatFingerprint({ kind: 'export', path: 'src/foo.ts', symbol: 'bar' })).toBe('export:src/foo.ts#bar')
  })

  it('formats dependency findings (path is package.json)', () => {
    expect(formatFingerprint({ kind: 'dependency', path: 'packages/foo/package.json', symbol: 'lodash' })).toBe(
      'dependency:packages/foo/package.json#lodash',
    )
  })
})

describe('findSkipMatch', () => {
  it('matches exact entry by fingerprint', () => {
    const list: SkipList = {
      version: 1,
      entries: [
        {
          fingerprint: { kind: 'file', path: 'src/foo.ts' },
          reason: 'public-api',
          addedAt: '2026-05-14T00:00:00Z',
          addedBy: 'maintainer',
        },
      ],
      rules: [],
    }
    const match = findSkipMatch(list, { kind: 'file', path: 'src/foo.ts' })
    expect(match).not.toBeNull()
    expect((match as { reason: string }).reason).toBe('public-api')
  })

  it('returns null when neither entries nor rules match', () => {
    const list = emptySkipList()
    expect(findSkipMatch(list, { kind: 'file', path: 'src/unknown.ts' })).toBeNull()
  })

  it('matches rule by glob scope', () => {
    const list: SkipList = {
      version: 1,
      entries: [],
      rules: [
        {
          rule: 'gazetta-public-entries',
          scope: 'packages/gazetta/src/index.ts',
          reason: 'public-api',
          addedAt: '2026-05-14T00:00:00Z',
          addedBy: 'bot',
          compactedFrom: 3,
        },
      ],
    }
    const match = findSkipMatch(list, { kind: 'export', path: 'packages/gazetta/src/index.ts', symbol: 'X' })
    expect(match).not.toBeNull()
    expect((match as { rule: string }).rule).toBe('gazetta-public-entries')
  })

  it('honors rule kind filter — skip when kind does not match', () => {
    const list: SkipList = {
      version: 1,
      entries: [],
      rules: [
        {
          rule: 'only-files',
          scope: 'packages/**/*.ts',
          kinds: ['file'],
          reason: 'public-api',
          addedAt: '2026-05-14T00:00:00Z',
          addedBy: 'bot',
          compactedFrom: 2,
        },
      ],
    }
    // Rule kinds=['file']; finding kind='export' — no match
    const match = findSkipMatch(list, { kind: 'export', path: 'packages/foo/bar.ts', symbol: 'X' })
    expect(match).toBeNull()
  })

  it('honors rule kind filter — match when kind included', () => {
    const list: SkipList = {
      version: 1,
      entries: [],
      rules: [
        {
          rule: 'only-files',
          scope: 'packages/**/*.ts',
          kinds: ['file'],
          reason: 'public-api',
          addedAt: '2026-05-14T00:00:00Z',
          addedBy: 'bot',
          compactedFrom: 2,
        },
      ],
    }
    const match = findSkipMatch(list, { kind: 'file', path: 'packages/foo/bar.ts' })
    expect(match).not.toBeNull()
  })

  it('prefers entry match over rule match (entries checked first)', () => {
    const list: SkipList = {
      version: 1,
      entries: [
        {
          fingerprint: { kind: 'file', path: 'src/foo.ts' },
          reason: 'public-api',
          addedAt: '2026-05-14T00:00:00Z',
          addedBy: 'maintainer',
        },
      ],
      rules: [
        {
          rule: 'broad',
          scope: 'src/**',
          reason: 'planned-feature',
          addedAt: '2026-05-14T00:00:00Z',
          addedBy: 'bot',
          compactedFrom: 1,
        },
      ],
    }
    const match = findSkipMatch(list, { kind: 'file', path: 'src/foo.ts' })
    expect(match).not.toBeNull()
    // Entry's reason wins (was checked first)
    expect((match as { reason: string }).reason).toBe('public-api')
  })
})

describe('appendEntry', () => {
  it('adds a new entry when fingerprint is unseen', () => {
    const list = emptySkipList()
    const added = appendEntry(list, {
      fingerprint: { kind: 'file', path: 'src/foo.ts' },
      reason: 'planned-feature',
      addedAt: '2026-05-14T00:00:00Z',
      addedBy: 'bot',
    })
    expect(added).toBe(true)
    expect(list.entries).toHaveLength(1)
  })

  it('skips duplicate fingerprint', () => {
    const list = emptySkipList()
    appendEntry(list, {
      fingerprint: { kind: 'file', path: 'src/foo.ts' },
      reason: 'planned-feature',
      addedAt: '2026-05-14T00:00:00Z',
      addedBy: 'bot',
    })
    const added = appendEntry(list, {
      fingerprint: { kind: 'file', path: 'src/foo.ts' },
      reason: 'maintainer-rejected',
      addedAt: '2026-05-15T00:00:00Z',
      addedBy: 'bot',
    })
    expect(added).toBe(false)
    expect(list.entries).toHaveLength(1)
    // Original entry retained, NOT overwritten
    expect(list.entries[0].reason).toBe('planned-feature')
  })
})

describe('readSkipList / writeSkipList', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(resolve(tmpdir(), 'skip-list-test-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('returns empty list when file does not exist', () => {
    const path = resolve(tempDir, 'missing.json')
    const list = readSkipList(path)
    expect(list).toEqual(emptySkipList())
  })

  it('round-trips through disk', () => {
    const original: SkipList = {
      version: 1,
      entries: [
        {
          fingerprint: { kind: 'file', path: 'src/foo.ts' },
          reason: 'public-api',
          addedAt: '2026-05-14T00:00:00Z',
          addedBy: 'maintainer',
        },
      ],
      rules: [
        {
          rule: 'r1',
          scope: 'src/**',
          reason: 'public-api',
          addedAt: '2026-05-14T00:00:00Z',
          addedBy: 'bot',
          compactedFrom: 5,
        },
      ],
    }
    const path = resolve(tempDir, 'skip.json')
    writeSkipList(path, original)
    const roundtripped = readSkipList(path)
    expect(roundtripped).toEqual(original)
  })

  it('throws on unknown version', () => {
    const path = resolve(tempDir, 'bad.json')
    // Write a manually-constructed bad-version file
    const raw = `{"version":999,"entries":[],"rules":[]}\n`
    writeSkipList(path, JSON.parse(raw))
    expect(() => readSkipList(path)).toThrow(/unknown version/)
  })
})
