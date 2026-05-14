import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendReviewerLog,
  pruneReviewerLog,
  readReviewerLog,
  type ReviewerLogEntry,
  tailReviewerLog,
} from '../reviewer-log.js'

let dir: string
let logPath: string

function entry(overrides: Partial<ReviewerLogEntry> = {}): ReviewerLogEntry {
  return {
    ts: '2026-05-14T12:00:00Z',
    runId: '123',
    fingerprint: { kind: 'file', path: 'src/foo.ts' },
    fingerprintLabel: 'file:src/foo.ts',
    attempt: 1,
    verdict: 'approve',
    reasoning: 'no callers, clean delete',
    agentASummary: 'removed barrel file',
    ...overrides,
  }
}

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'dcw-reviewer-log-test-'))
  logPath = resolve(dir, 'reviewer-log.jsonl')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('appendReviewerLog + readReviewerLog (dead-code-watcher)', () => {
  it('round-trips a single entry with knip fingerprint', () => {
    const e = entry()
    appendReviewerLog(logPath, e)
    expect(readReviewerLog(logPath)).toEqual([e])
  })

  it('appends in order across verdict types', () => {
    const a = entry({ attempt: 1, verdict: 'reject', reasoning: 'tautological test' })
    const b = entry({ attempt: 2, verdict: 'approve', reasoning: 'fixed on retry' })
    const c = entry({
      fingerprint: { kind: 'export', path: 'src/bar.ts', symbol: 'unused' },
      fingerprintLabel: 'export:src/bar.ts#unused',
      verdict: 'needs-human',
    })
    appendReviewerLog(logPath, a)
    appendReviewerLog(logPath, b)
    appendReviewerLog(logPath, c)
    expect(readReviewerLog(logPath)).toEqual([a, b, c])
  })
})

describe('readReviewerLog (dead-code-watcher)', () => {
  it('returns [] when file does not exist', () => {
    expect(readReviewerLog(resolve(dir, 'missing.jsonl'))).toEqual([])
  })

  it('skips malformed lines', () => {
    const good = entry()
    writeFileSync(logPath, `${JSON.stringify(good)}\nbroken\n${JSON.stringify(good)}\n`)
    expect(readReviewerLog(logPath)).toEqual([good, good])
  })
})

describe('tailReviewerLog (dead-code-watcher)', () => {
  it('returns last N entries', () => {
    for (let i = 1; i <= 10; i++) appendReviewerLog(logPath, entry({ attempt: i }))
    expect(tailReviewerLog(logPath, 3).map(e => e.attempt)).toEqual([8, 9, 10])
  })

  it('returns all when N exceeds size', () => {
    appendReviewerLog(logPath, entry({ attempt: 1 }))
    expect(tailReviewerLog(logPath, 100)).toHaveLength(1)
  })
})

describe('pruneReviewerLog (dead-code-watcher)', () => {
  it('truncates to the last N entries', () => {
    for (let i = 1; i <= 10; i++) appendReviewerLog(logPath, entry({ attempt: i }))
    const result = pruneReviewerLog(logPath, 3)
    expect(result).toEqual({ dropped: 7, kept: 3 })
    expect(readReviewerLog(logPath).map(e => e.attempt)).toEqual([8, 9, 10])
  })

  it('is a no-op when under threshold', () => {
    for (let i = 1; i <= 3; i++) appendReviewerLog(logPath, entry({ attempt: i }))
    const result = pruneReviewerLog(logPath, 100)
    expect(result).toEqual({ dropped: 0, kept: 3 })
    expect(readReviewerLog(logPath)).toHaveLength(3)
  })

  it('handles empty/missing file', () => {
    const result = pruneReviewerLog(resolve(dir, 'missing.jsonl'), 10)
    expect(result).toEqual({ dropped: 0, kept: 0 })
  })

  it('prune is idempotent — second call drops nothing', () => {
    for (let i = 1; i <= 10; i++) appendReviewerLog(logPath, entry({ attempt: i }))
    pruneReviewerLog(logPath, 3)
    const second = pruneReviewerLog(logPath, 3)
    expect(second).toEqual({ dropped: 0, kept: 3 })
  })

  it('written file has trailing newline (matches append format)', () => {
    for (let i = 1; i <= 5; i++) appendReviewerLog(logPath, entry({ attempt: i }))
    pruneReviewerLog(logPath, 2)
    // Append after prune must still produce valid JSONL — no double-newlines, no missing-newline corruption.
    appendReviewerLog(logPath, entry({ attempt: 99 }))
    const entries = readReviewerLog(logPath)
    expect(entries.map(e => e.attempt)).toEqual([4, 5, 99])
  })
})
