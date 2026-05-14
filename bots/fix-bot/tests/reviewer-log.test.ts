import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendReviewerLog, readReviewerLog, type ReviewerLogEntry, tailReviewerLog } from '../reviewer-log.js'

let dir: string
let logPath: string

function entry(overrides: Partial<ReviewerLogEntry> = {}): ReviewerLogEntry {
  return {
    ts: '2026-05-14T12:00:00Z',
    runId: '123',
    fingerprint: { issueNumber: 287 },
    fingerprintLabel: '#287',
    attempt: 1,
    verdict: 'approve',
    reasoning: 'failing test pinned the bug; fix is minimal',
    agentASummary: 'added regression test for the duplicate-publish race; one-line fix in publish.ts',
    ...overrides,
  }
}

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'fix-bot-reviewer-log-test-'))
  logPath = resolve(dir, 'reviewer-log.jsonl')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('appendReviewerLog + readReviewerLog (fix-bot)', () => {
  it('round-trips an entry keyed by issue number', () => {
    const e = entry()
    appendReviewerLog(logPath, e)
    expect(readReviewerLog(logPath)).toEqual([e])
  })

  it('appends in order across verdict types', () => {
    const reject = entry({ verdict: 'reject', reasoning: 'test asserts on observed output' })
    const approve = entry({ attempt: 2, verdict: 'approve', reasoning: 'retry fixed the tautology' })
    const human = entry({ fingerprint: { issueNumber: 999 }, fingerprintLabel: '#999', verdict: 'needs-human' })
    appendReviewerLog(logPath, reject)
    appendReviewerLog(logPath, approve)
    appendReviewerLog(logPath, human)
    expect(readReviewerLog(logPath)).toEqual([reject, approve, human])
  })
})

describe('readReviewerLog (fix-bot)', () => {
  it('returns [] when file does not exist', () => {
    expect(readReviewerLog(resolve(dir, 'missing.jsonl'))).toEqual([])
  })

  it('skips malformed lines', () => {
    const good = entry()
    writeFileSync(logPath, `${JSON.stringify(good)}\nbroken\n${JSON.stringify(good)}\n`)
    expect(readReviewerLog(logPath)).toEqual([good, good])
  })
})

describe('tailReviewerLog (fix-bot)', () => {
  it('returns last N entries', () => {
    for (let i = 1; i <= 10; i++) appendReviewerLog(logPath, entry({ attempt: i }))
    expect(tailReviewerLog(logPath, 3).map(e => e.attempt)).toEqual([8, 9, 10])
  })
})
