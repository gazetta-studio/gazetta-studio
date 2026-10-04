/**
 * Compactor gate + prompt. The gate's counting rule is the load-bearing
 * part: only runs that ACTED are evidence about how cuts are specified.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { composeCompactPrompt, shouldCompact } from '../compact-helpers.js'
import type { DecisionLogEntry } from '../decision-log.js'

const e = (outcome: DecisionLogEntry['outcome']): DecisionLogEntry => ({ at: 'x', runId: '1', decisions: [], outcome })

describe('shouldCompact', () => {
  it('counts only acted runs — a month of quota-stops is not signal', () => {
    const log = [e('quota-stop'), e('quota-stop'), e('budget-stop'), e('idle'), e('idle'), e('acted')]
    expect(shouldCompact(log, 2, false)).toEqual({ run: false, reason: 'below-threshold', signal: 1, threshold: 2 })
  })

  it('runs at exactly the threshold', () => {
    expect(shouldCompact([e('acted'), e('acted')], 2, false)).toEqual({ run: true })
  })

  it('reports below-threshold even on a dry run (threshold is checked first)', () => {
    expect(shouldCompact([], 1, true)).toMatchObject({ reason: 'below-threshold' })
    expect(shouldCompact([e('acted')], 1, true)).toEqual({ run: false, reason: 'dry-run' })
  })
})

describe('composeCompactPrompt', () => {
  it('carries every input the prompt documents', () => {
    const p = composeCompactPrompt({
      template: 'TEMPLATE',
      lessonsPath: 'L.md',
      log: [e('acted')],
      previousLessons: 'OLD LESSONS',
      runId: '42',
    })
    for (const needle of ['TEMPLATE', 'LESSONS_PATH=L.md', 'RUN_ID=42', '"outcome": "acted"', 'OLD LESSONS'])
      expect(p).toContain(needle)
  })
})

describe('decision-log cache wiring (the #854 failure mode)', () => {
  const wf = (f: string) => readFileSync(join(__dirname, '..', '..', '..', '.github', 'workflows', f), 'utf-8')
  const job = wf('bots-compact.yml').split(/\n  cut-planner:\n/)[1] ?? ''

  it('the compactor restores via restore-keys, so it finds the daily runs’ per-run entries', () => {
    // A static exact key with no restore-keys never matches the daily
    // `...-v1-<run_id>` entries — the compactor would read a stale log.
    expect(job).toContain('actions/cache/restore@')
    expect(job).toMatch(/restore-keys: \|\n\s+cut-planner-decision-log-v1-\n/)
  })

  it('the daily bot restores the same key family the compactor saves', () => {
    expect(wf('cut-planner.yml')).toMatch(/restore-keys: \|\n\s+cut-planner-decision-log-v1-\n/)
    expect(job).toContain('key: cut-planner-decision-log-v1-${{ github.run_id }}')
  })
})
