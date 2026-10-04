/**
 * decision-log helpers. Per-test tempdir (rule 26): the helpers write real
 * files, so no two tests share a path.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  appendDecisionLog,
  type DecisionLogEntry,
  DECISION_LOG_PATH,
  pruneDecisionLog,
  tailDecisionLog,
} from '../decision-log.js'

const fresh = () => join(mkdtempSync(join(tmpdir(), 'cut-planner-log-')), 'decision-log.jsonl')
const entry = (n: number): DecisionLogEntry => ({
  at: `2026-10-0${n}T00:00:00Z`,
  runId: String(n),
  decisions: [{ planner: 1, feature: 'rw', decision: 'file the next cut' }],
  outcome: 'acted',
  action: { planner: 1, feature: 'rw', summary: `filed #${100 + n}` },
})

describe('decision-log', () => {
  it('appends one JSON line per entry and reads them back in order', () => {
    const p = fresh()
    appendDecisionLog(p, entry(1))
    appendDecisionLog(p, entry(2))
    expect(readFileSync(p, 'utf-8').trim().split('\n')).toHaveLength(2)
    expect(tailDecisionLog(p, 10).map(e => e.runId)).toEqual(['1', '2'])
  })

  it('tails the last n', () => {
    const p = fresh()
    for (let i = 1; i <= 5; i++) appendDecisionLog(p, entry(i))
    expect(tailDecisionLog(p, 2).map(e => e.runId)).toEqual(['4', '5'])
  })

  it('returns [] for a missing file (a cache miss is not an error)', () => {
    expect(tailDecisionLog(fresh(), 10)).toEqual([])
  })

  it('skips a malformed line instead of losing the whole log', () => {
    const p = fresh()
    appendDecisionLog(p, entry(1))
    writeFileSync(p, `${readFileSync(p, 'utf-8')}{partial-wri\n`)
    appendDecisionLog(p, entry(2))
    expect(tailDecisionLog(p, 10).map(e => e.runId)).toEqual(['1', '2'])
  })

  it('prunes to the most recent entries and reports what it dropped', () => {
    const p = fresh()
    for (let i = 1; i <= 5; i++) appendDecisionLog(p, entry(i))
    expect(pruneDecisionLog(p, 3)).toEqual({ dropped: 2, kept: 3 })
    expect(tailDecisionLog(p, 10).map(e => e.runId)).toEqual(['3', '4', '5'])
  })

  it('leaves a log at or under the limit untouched', () => {
    const p = fresh()
    appendDecisionLog(p, entry(1))
    expect(pruneDecisionLog(p, 3)).toEqual({ dropped: 0, kept: 1 })
  })

  it('is the path the workflow caches — otherwise every run starts from nothing', () => {
    const wf = readFileSync(join(__dirname, '..', '..', '..', '.github', 'workflows', 'cut-planner.yml'), 'utf-8')
    expect(wf).toContain(`path: ${DECISION_LOG_PATH}`)
  })
})
