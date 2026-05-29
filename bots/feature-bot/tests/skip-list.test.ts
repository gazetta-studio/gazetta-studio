/**
 * Feature-bot skip-list tests — failing-test commit per rule 31 TDD-first ordering.
 *
 * Mirrors fix-bot's skip-list contract but extends the SkipReason union
 * with 4 feature-bot-specific reasons per design-feature-bot.md Q7:
 *   - missing-prereq
 *   - spec-too-vague
 *   - input-cycles-exceeded
 *   - files-conflict
 *
 * Plus the 4 reasons reused from fix-bot:
 *   - needs-human
 *   - maintainer-rejected
 *   - tautological-test
 *   - wrong-root-cause
 *
 * Total: 8 values. Compile-time check via `satisfies` confirms every
 * value is reachable from the union.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendEntry,
  emptySkipList,
  findSkipMatch,
  readSkipList,
  type SkipList,
  type SkipReason,
  writeSkipList,
} from '../skip-list.js'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(resolve(tmpdir(), 'feature-bot-skip-list-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('readSkipList', () => {
  it('returns empty when file is missing', () => {
    const list = readSkipList(resolve(tmp, 'does-not-exist.json'))
    expect(list).toEqual(emptySkipList())
    expect(list.entries).toEqual([])
  })

  it('returns parsed entries from existing JSON', () => {
    const path = resolve(tmp, 'skip-list.json')
    const seed: SkipList = {
      version: 1,
      entries: [
        {
          fingerprint: { issueNumber: 501 },
          reason: 'spec-too-vague',
          reasonNote: 'Cut spec missed Acceptance section',
          addedAt: '2026-05-30T00:00:00Z',
          addedBy: 'bot',
        },
      ],
    }
    writeSkipList(path, seed)
    const read = readSkipList(path)
    expect(read.entries).toHaveLength(1)
    expect(read.entries[0].fingerprint.issueNumber).toBe(501)
    expect(read.entries[0].reason).toBe('spec-too-vague')
  })
})

describe('writeSkipList', () => {
  it('round-trips through readSkipList', () => {
    const path = resolve(tmp, 'skip-list.json')
    const original: SkipList = {
      version: 1,
      entries: [
        {
          fingerprint: { issueNumber: 502 },
          reason: 'missing-prereq',
          reasonNote: 'Required infrastructure not present despite closed deps',
          addedAt: '2026-05-30T01:00:00Z',
          addedBy: 'bot',
        },
        {
          fingerprint: { issueNumber: 503 },
          reason: 'input-cycles-exceeded',
          reasonNote: 'Two NEEDS_INPUT cycles on same cut',
          addedAt: '2026-05-30T02:00:00Z',
          addedBy: 'bot',
        },
      ],
    }
    writeSkipList(path, original)
    const round = readSkipList(path)
    expect(round).toEqual(original)
  })
})

describe('appendEntry', () => {
  it('adds an entry; subsequent findSkipMatch finds it by issueNumber', () => {
    const list = emptySkipList()
    const added = appendEntry(list, {
      fingerprint: { issueNumber: 600 },
      reason: 'files-conflict',
      reasonNote: 'Cut overlaps with another in-flight cut',
      addedAt: '2026-05-30T03:00:00Z',
      addedBy: 'bot',
    })
    expect(added).toBe(true)
    expect(list.entries).toHaveLength(1)

    const match = findSkipMatch(list, { issueNumber: 600 })
    expect(match).not.toBeNull()
    expect(match?.reason).toBe('files-conflict')
  })

  it('is idempotent on duplicate fingerprint+reason', () => {
    const list = emptySkipList()
    const first = appendEntry(list, {
      fingerprint: { issueNumber: 700 },
      reason: 'tautological-test',
      reasonNote: 'Reviewer caught fake-pass test',
      addedAt: '2026-05-30T04:00:00Z',
      addedBy: 'bot',
    })
    const second = appendEntry(list, {
      fingerprint: { issueNumber: 700 },
      reason: 'tautological-test',
      reasonNote: 'Different note but same fingerprint',
      addedAt: '2026-05-30T05:00:00Z',
      addedBy: 'bot',
    })
    expect(first).toBe(true)
    expect(second).toBe(false)
    expect(list.entries).toHaveLength(1)
  })

  it('returns null from findSkipMatch when no entry matches', () => {
    const list = emptySkipList()
    expect(findSkipMatch(list, { issueNumber: 9999 })).toBeNull()
  })
})

describe('SkipReason union (Q7 lock — 8 values)', () => {
  it('accepts all 8 reason values from design-feature-bot.md Q7', () => {
    // Compile-time check via `satisfies`: TypeScript narrows the array
    // literal to the exact union, so missing/extra values fail to compile.
    // Runtime sanity check: every value can be assigned and read.
    const reasons = [
      // Reused from fix-bot
      'needs-human',
      'maintainer-rejected',
      'tautological-test',
      'wrong-root-cause',
      // Feature-bot additions
      'missing-prereq',
      'spec-too-vague',
      'input-cycles-exceeded',
      'files-conflict',
    ] as const satisfies readonly SkipReason[]

    expect(reasons).toHaveLength(8)

    // Each value must round-trip through an entry to confirm the
    // SkipReason union admits it (and not, say, a typo'd variant).
    for (const reason of reasons) {
      const list = emptySkipList()
      const added = appendEntry(list, {
        fingerprint: { issueNumber: 1000 + reasons.indexOf(reason) },
        reason,
        reasonNote: `Test entry for reason=${reason}`,
        addedAt: '2026-05-30T00:00:00Z',
        addedBy: 'bot',
      })
      expect(added).toBe(true)
      expect(list.entries[0].reason).toBe(reason)
    }
  })
})
