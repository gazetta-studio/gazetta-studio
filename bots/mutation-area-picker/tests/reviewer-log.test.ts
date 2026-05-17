import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendReviewerLog,
  countWeeklyRuns,
  pruneReviewerLog,
  readReviewerLog,
  type ReviewerLogEntry,
  tailReviewerLog,
} from '../reviewer-log.js'

let dir: string
let logPath: string

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'map-reviewer-log-test-'))
  logPath = resolve(dir, 'reviewer-log.jsonl')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function entry(overrides: Partial<ReviewerLogEntry> = {}): ReviewerLogEntry {
  return {
    ts: '2026-05-17T12:00:00Z',
    runId: 'run-1',
    action: 'add',
    addedModule: 'packages/gazetta/src/archive/index.ts',
    removedModule: null,
    topInclusionScore: 0.72,
    worstEvictionScore: 0.3,
    estimatedRuntimeAfterMinutes: 120,
    reasoning: 'top candidate scored above INCLUSION_THRESHOLD',
    bootstrapWeek: null,
    ...overrides,
  }
}

describe('appendReviewerLog + readReviewerLog', () => {
  it('round-trips a single entry', () => {
    appendReviewerLog(logPath, entry())
    expect(readReviewerLog(logPath)).toEqual([entry()])
  })

  it('appends in order across action types', () => {
    appendReviewerLog(logPath, entry({ action: 'add', runId: 'run-1' }))
    appendReviewerLog(logPath, entry({ action: 'noop', runId: 'run-2', addedModule: null }))
    appendReviewerLog(logPath, entry({ action: 'swap', runId: 'run-3', removedModule: 'src/foo.ts' }))
    appendReviewerLog(
      logPath,
      entry({ action: 'remove', runId: 'run-4', addedModule: null, removedModule: 'src/bar.ts' }),
    )
    const all = readReviewerLog(logPath)
    expect(all.map(e => e.action)).toEqual(['add', 'noop', 'swap', 'remove'])
  })

  it('returns [] when file is missing', () => {
    expect(readReviewerLog(resolve(dir, 'missing.jsonl'))).toEqual([])
  })

  it('skips malformed lines', () => {
    const good = entry()
    writeFileSync(logPath, `${JSON.stringify(good)}\nbroken\n${JSON.stringify(good)}\n`)
    expect(readReviewerLog(logPath)).toEqual([good, good])
  })
})

describe('tailReviewerLog', () => {
  it('returns last N entries', () => {
    for (let i = 1; i <= 10; i++) appendReviewerLog(logPath, entry({ runId: `r${i}` }))
    expect(tailReviewerLog(logPath, 3).map(e => e.runId)).toEqual(['r8', 'r9', 'r10'])
  })
})

describe('countWeeklyRuns', () => {
  it('returns 0 for empty entries', () => {
    expect(countWeeklyRuns([])).toBe(0)
  })

  it('counts distinct YYYY-MM-DD dates', () => {
    const entries = [
      entry({ ts: '2026-05-17T05:00:00Z' }),
      entry({ ts: '2026-05-17T06:00:00Z' }), // same day, doesn't count again
      entry({ ts: '2026-05-24T05:00:00Z' }),
      entry({ ts: '2026-05-31T05:00:00Z' }),
    ]
    expect(countWeeklyRuns(entries)).toBe(3)
  })
})

describe('pruneReviewerLog', () => {
  it('truncates to the last N entries', () => {
    for (let i = 1; i <= 10; i++) appendReviewerLog(logPath, entry({ runId: `r${i}` }))
    const result = pruneReviewerLog(logPath, 3)
    expect(result).toEqual({ dropped: 7, kept: 3 })
    expect(readReviewerLog(logPath).map(e => e.runId)).toEqual(['r8', 'r9', 'r10'])
  })

  it('is a no-op when under threshold', () => {
    appendReviewerLog(logPath, entry())
    expect(pruneReviewerLog(logPath, 100)).toEqual({ dropped: 0, kept: 1 })
  })

  it('handles missing file', () => {
    expect(pruneReviewerLog(resolve(dir, 'missing.jsonl'), 10)).toEqual({ dropped: 0, kept: 0 })
  })

  it('subsequent append works after prune', () => {
    for (let i = 1; i <= 5; i++) appendReviewerLog(logPath, entry({ runId: `r${i}` }))
    pruneReviewerLog(logPath, 2)
    appendReviewerLog(logPath, entry({ runId: 'r99' }))
    expect(readReviewerLog(logPath).map(e => e.runId)).toEqual(['r4', 'r5', 'r99'])
  })
})
