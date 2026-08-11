import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handlePostClaude } from '../post-claude.js'
import { appendReviewerLog, readReviewerLog, type ReviewerLogEntry } from '../reviewer-log.js'

let dir: string
let lessonsPath: string
let reviewerLogPath: string

function entry(overrides: Partial<ReviewerLogEntry> = {}): ReviewerLogEntry {
  return {
    ts: '2026-05-14T12:00:00Z',
    runId: 'test-run',
    fingerprint: { kind: 'file', path: 'src/foo.ts' },
    fingerprintLabel: 'file:src/foo.ts',
    attempt: 1,
    verdict: 'approve',
    reasoning: 'no callers, clean delete',
    agentASummary: 'removed barrel file',
    ...overrides,
  }
}

function seedReviewerLog(n: number): void {
  for (let i = 1; i <= n; i++) appendReviewerLog(reviewerLogPath, entry({ attempt: i }))
}

/** Signal header says 10, sub-tallies sum to 8 — the drift shape the guard fires on. */
const LESSONS_WITH_DRIFT = `## Findings

**Signal:** 10 verdicts (foo)

- clean-delete (5):
- risky-delete (3):
`

/** Signal header 8, sub-tallies sum to 8 — no drift. */
const LESSONS_CLEAN = `## Findings

**Signal:** 8 verdicts (foo)

- clean-delete (5):
- risky-delete (3):
`

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'dcw-post-claude-test-'))
  lessonsPath = resolve(dir, 'lessons-learned.md')
  reviewerLogPath = resolve(dir, 'reviewer-log.jsonl')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('handlePostClaude (dead-code-watcher compact)', () => {
  it('Claude failed → no prune, no exit, reviewer-log untouched', () => {
    seedReviewerLog(500)
    // Even a drifting lessons file must not surface violations here — the
    // run has already decided we do not trust Claude's outputs this cycle.
    writeFileSync(lessonsPath, LESSONS_WITH_DRIFT)

    const outcome = handlePostClaude({
      claudeSucceeded: false,
      lessonsPath,
      reviewerLogPath,
      keepLast: 200,
    })

    expect(outcome).toEqual({ exitCode: 0, violations: [], prune: null })
    // Counterfactual: if the helper ignored `claudeSucceeded` and always
    // pruned, the file would drop to 200 entries. 500 here proves the
    // branch is honored — the input for next month is preserved.
    expect(readReviewerLog(reviewerLogPath)).toHaveLength(500)
  })

  it('Claude succeeded + signal-count drift → exit 1, prune NOT called (validation-before-prune ordering)', () => {
    seedReviewerLog(500)
    writeFileSync(lessonsPath, LESSONS_WITH_DRIFT)

    const outcome = handlePostClaude({
      claudeSucceeded: true,
      lessonsPath,
      reviewerLogPath,
      keepLast: 200,
    })

    expect(outcome.exitCode).toBe(1)
    expect(outcome.violations).toHaveLength(1)
    expect(outcome.violations[0]).toMatchObject({ header: 10, sum: 8 })
    // The load-bearing invariant: violations must produce `prune: null`,
    // structurally guaranteeing the caller never reaches the prune branch.
    expect(outcome.prune).toBeNull()
    // Counterfactual: if the ordering were swapped (prune first, then
    // check violations), the reviewer-log would have dropped to 200
    // entries here. 500 proves validation-before-prune ordering holds —
    // this is the regression that would silently corrupt the input
    // across monthly cron cycles.
    expect(readReviewerLog(reviewerLogPath)).toHaveLength(500)
  })

  it('Claude succeeded + clean lessons → prune called with keepLast', () => {
    seedReviewerLog(500)
    writeFileSync(lessonsPath, LESSONS_CLEAN)

    const outcome = handlePostClaude({
      claudeSucceeded: true,
      lessonsPath,
      reviewerLogPath,
      keepLast: 200,
    })

    expect(outcome.exitCode).toBe(0)
    expect(outcome.violations).toEqual([])
    // Counterfactual: if the helper never called pruneReviewerLog, `prune`
    // would be null and the file would still hold 500 entries. The exact
    // 300/200 split pins that keepLast is honored (not a hardcoded value).
    expect(outcome.prune).toEqual({ dropped: 300, kept: 200 })
    expect(readReviewerLog(reviewerLogPath)).toHaveLength(200)
  })

  it('Claude succeeded + missing lessons file → treated as clean; prune runs', () => {
    seedReviewerLog(50)
    // Deliberately do NOT create lessonsPath. Boundary condition: the
    // helper must tolerate an absent file (existsSync branch) without
    // throwing, and treat "no content" as no violations.

    const outcome = handlePostClaude({
      claudeSucceeded: true,
      lessonsPath,
      reviewerLogPath,
      keepLast: 200,
    })

    expect(outcome.exitCode).toBe(0)
    expect(outcome.violations).toEqual([])
    // Under threshold — nothing dropped, but prune was still invoked
    // (proven by the `{dropped, kept}` shape being present, not null).
    // Counterfactual: if the helper threw on missing lessons, we'd never
    // reach this assertion.
    expect(outcome.prune).toEqual({ dropped: 0, kept: 50 })
  })
})
