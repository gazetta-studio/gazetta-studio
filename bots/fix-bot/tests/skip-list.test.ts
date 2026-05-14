import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendEntry,
  emptySkipList,
  findSkipMatch,
  matchesRule,
  readSkipList,
  type SkipList,
  writeSkipList,
} from '../skip-list.js'

describe('matchesRule', () => {
  it('matches by exact label name', () => {
    expect(matchesRule('area: deploy', { title: 'X', labels: ['bug', 'area: deploy'] })).toBe(true)
    expect(matchesRule('area: deploy', { title: 'X', labels: ['bug', 'area: cms'] })).toBe(false)
  })

  it('matches by title regex when prefix is re:', () => {
    expect(matchesRule('re:^Flaky e2e:', { title: 'Flaky e2e: foo.spec.ts:30', labels: [] })).toBe(true)
    expect(matchesRule('re:^Flaky e2e:', { title: 'Flaky vitest: bar.test.ts:30', labels: [] })).toBe(false)
  })

  it('returns false for malformed regex without crashing', () => {
    expect(matchesRule('re:[invalid', { title: 'anything', labels: [] })).toBe(false)
  })

  it('label match is exact, not substring', () => {
    expect(matchesRule('area: deploy', { title: 'X', labels: ['area: deploy-target'] })).toBe(false)
  })
})

describe('findSkipMatch', () => {
  const baseCtx = { title: 'Some issue', labels: ['bug'] }

  it('matches exact entry by issue number', () => {
    const list: SkipList = {
      version: 1,
      entries: [
        {
          fingerprint: { issueNumber: 100 },
          reason: 'maintainer-rejected',
          reasonNote: 'wrong root cause',
          addedAt: '2026-05-14T00:00:00Z',
          addedBy: 'bot',
          refPR: 312,
        },
      ],
      rules: [],
    }
    const match = findSkipMatch(list, { issueNumber: 100 }, baseCtx)
    expect(match).not.toBeNull()
    expect((match as { reason: string }).reason).toBe('maintainer-rejected')
  })

  it('returns null when neither entries nor rules match', () => {
    expect(findSkipMatch(emptySkipList(), { issueNumber: 999 }, baseCtx)).toBeNull()
  })

  it('matches rule by label', () => {
    const list: SkipList = {
      version: 1,
      entries: [],
      rules: [
        {
          rule: 'deploy-area-skipped',
          scope: 'area: deploy',
          reason: 'out-of-scope',
          reasonNote: 'Deploy adapters need maintainer judgment.',
          addedAt: '2026-05-14T00:00:00Z',
          addedBy: 'bot',
          compactedFrom: 3,
        },
      ],
    }
    const match = findSkipMatch(list, { issueNumber: 200 }, { title: 'X', labels: ['bug', 'area: deploy'] })
    expect(match).not.toBeNull()
    expect((match as { rule: string }).rule).toBe('deploy-area-skipped')
  })

  it('matches rule by title regex', () => {
    const list: SkipList = {
      version: 1,
      entries: [],
      rules: [
        {
          rule: 'flaky-vitest-needs-human',
          scope: 're:^Flaky vitest:',
          reason: 'needs-human',
          reasonNote: 'Vitest flakes need maintainer to determine isolation strategy.',
          addedAt: '2026-05-14T00:00:00Z',
          addedBy: 'bot',
          compactedFrom: 2,
        },
      ],
    }
    const match = findSkipMatch(list, { issueNumber: 200 }, { title: 'Flaky vitest: hash.test.ts', labels: ['bug'] })
    expect(match).not.toBeNull()
  })

  it('prefers entry over rule (entries checked first)', () => {
    const list: SkipList = {
      version: 1,
      entries: [
        {
          fingerprint: { issueNumber: 100 },
          reason: 'maintainer-rejected',
          reasonNote: 'specific-rejection',
          addedAt: '2026-05-14T00:00:00Z',
          addedBy: 'bot',
        },
      ],
      rules: [
        {
          rule: 'broad',
          scope: 'bug',
          reason: 'out-of-scope',
          reasonNote: 'rule-rejection',
          addedAt: '2026-05-14T00:00:00Z',
          addedBy: 'bot',
          compactedFrom: 1,
        },
      ],
    }
    const match = findSkipMatch(list, { issueNumber: 100 }, { title: 'X', labels: ['bug'] })
    expect((match as { reasonNote: string }).reasonNote).toBe('specific-rejection')
  })
})

describe('appendEntry', () => {
  it('adds new entry when issue is unseen', () => {
    const list = emptySkipList()
    const added = appendEntry(list, {
      fingerprint: { issueNumber: 100 },
      reason: 'maintainer-rejected',
      reasonNote: 'why',
      addedAt: '2026-05-14T00:00:00Z',
      addedBy: 'bot',
    })
    expect(added).toBe(true)
    expect(list.entries).toHaveLength(1)
  })

  it('skips duplicate issue number', () => {
    const list = emptySkipList()
    appendEntry(list, {
      fingerprint: { issueNumber: 100 },
      reason: 'maintainer-rejected',
      reasonNote: 'first',
      addedAt: '2026-05-14T00:00:00Z',
      addedBy: 'bot',
    })
    const added = appendEntry(list, {
      fingerprint: { issueNumber: 100 },
      reason: 'needs-human',
      reasonNote: 'second',
      addedAt: '2026-05-15T00:00:00Z',
      addedBy: 'bot',
    })
    expect(added).toBe(false)
    expect(list.entries).toHaveLength(1)
    expect(list.entries[0].reasonNote).toBe('first')
  })
})

describe('readSkipList / writeSkipList', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(resolve(tmpdir(), 'fix-bot-skip-list-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('returns empty list when file does not exist', () => {
    const path = resolve(tempDir, 'missing.json')
    expect(readSkipList(path)).toEqual(emptySkipList())
  })

  it('round-trips through disk', () => {
    const original: SkipList = {
      version: 1,
      entries: [
        {
          fingerprint: { issueNumber: 42 },
          reason: 'maintainer-rejected',
          reasonNote: 'wrong root cause',
          addedAt: '2026-05-14T00:00:00Z',
          addedBy: 'bot',
          refPR: 312,
        },
      ],
      rules: [],
    }
    const path = resolve(tempDir, 'skip.json')
    writeSkipList(path, original)
    expect(readSkipList(path)).toEqual(original)
  })
})
