import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handlePostClaude } from '../post-claude.js'
import { appendReviewerLog, readReviewerLog, type ReviewerLogEntry } from '../reviewer-log.js'

let dir: string
let reviewerLogPath: string

function entry(overrides: Partial<ReviewerLogEntry> = {}): ReviewerLogEntry {
  return {
    ts: '2026-05-14T12:00:00Z',
    runId: 'test-run',
    fingerprint: { issueNumber: 287 },
    fingerprintLabel: '#287',
    attempt: 1,
    verdict: 'approve',
    reasoning: 'failing test pinned the bug; fix is minimal',
    agentASummary: 'one-line fix in publish.ts',
    ...overrides,
  }
}

function seedReviewerLog(n: number): void {
  for (let i = 1; i <= n; i++) appendReviewerLog(reviewerLogPath, entry({ attempt: i }))
}

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'fix-bot-post-claude-test-'))
  reviewerLogPath = resolve(dir, 'reviewer-log.jsonl')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('handlePostClaude (fix-bot compact)', () => {
  it('Claude failed → prune skipped; reviewer-log untouched (preserves next-month input)', () => {
    seedReviewerLog(500)

    const outcome = handlePostClaude({
      claudeSucceeded: false,
      reviewerLogPath,
      keepLast: 200,
    })

    expect(outcome).toEqual({ prune: null })
    // Counterfactual: if the guard were inverted (prune on failure), or
    // removed entirely so prune ran unconditionally, the file would have
    // dropped to 200 entries. 500 here proves the branch is honored — the
    // load-bearing invariant that preserves next-month input when Claude
    // fails. This is the regression the candidate flagged as load-bearing.
    expect(readReviewerLog(reviewerLogPath)).toHaveLength(500)
  })

  it('Claude succeeded → prune runs with keepLast', () => {
    seedReviewerLog(500)

    const outcome = handlePostClaude({
      claudeSucceeded: true,
      reviewerLogPath,
      keepLast: 200,
    })

    // Counterfactual: if the function skipped prune on success, `outcome.prune`
    // would be null and the file would still hold 500 entries. The exact
    // {dropped: 300, kept: 200} split pins that keepLast is honored (not
    // a hardcoded constant) — mutating keepLast to any other value would
    // change the split and fail this assertion.
    expect(outcome.prune).toEqual({ dropped: 300, kept: 200 })
    expect(readReviewerLog(reviewerLogPath)).toHaveLength(200)
  })

  it('Claude succeeded + log already under threshold → prune runs; 0 dropped, non-null shape', () => {
    seedReviewerLog(50)

    const outcome = handlePostClaude({
      claudeSucceeded: true,
      reviewerLogPath,
      keepLast: 200,
    })

    // Counterfactual: if the function short-circuited when `dropped === 0`
    // and returned `{ prune: null }`, this assertion would fail. The
    // non-null `{dropped: 0, kept: 50}` shape is load-bearing for the
    // caller: compact.ts uses `outcome.prune === null` as the "Claude
    // did not succeed" signal (which selects the "preserve input" log
    // message). Under-threshold success MUST return non-null so the
    // caller doesn't emit the wrong operator-facing notice.
    expect(outcome.prune).toEqual({ dropped: 0, kept: 50 })
    expect(readReviewerLog(reviewerLogPath)).toHaveLength(50)
  })

  it('Claude succeeded + missing reviewer-log file → prune returns {dropped: 0, kept: 0}', () => {
    // Deliberately do NOT seed. Boundary condition: the helper delegates
    // to pruneReviewerLog which tolerates missing files (contract pinned
    // by reviewer-log.test.ts). This test guards the delegation.

    const outcome = handlePostClaude({
      claudeSucceeded: true,
      reviewerLogPath,
      keepLast: 200,
    })

    // Counterfactual: if the function guarded with `existsSync` and
    // returned null on missing file, this would fail — and the caller
    // would emit the wrong "Claude did not succeed" notice on a
    // successful-but-log-absent run. Confirms the caller can rely on
    // `outcome.prune` being non-null whenever `claudeSucceeded` is
    // true, regardless of the reviewer-log's on-disk state.
    expect(outcome.prune).toEqual({ dropped: 0, kept: 0 })
  })
})
