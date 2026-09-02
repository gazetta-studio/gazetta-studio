import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { composePrompt, handlePostClaude, shouldRunCompaction } from '../compact-helpers.js'
import { appendReviewerLog, readReviewerLog, type ReviewerLogEntry } from '../reviewer-log.js'

let dir: string
let reviewerLogPath: string

function entry(overrides: Partial<ReviewerLogEntry> = {}): ReviewerLogEntry {
  return {
    ts: '2026-05-14T12:00:00Z',
    runId: '123',
    fingerprint: { issueNumber: 287 },
    fingerprintLabel: '#287',
    attempt: 1,
    verdict: 'approve',
    reasoning: 'test entry',
    agentASummary: 'test summary',
    ...overrides,
  }
}

function seedReviewerLog(n: number): void {
  for (let i = 1; i <= n; i++) appendReviewerLog(reviewerLogPath, entry({ attempt: i }))
}

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'fixbot-compact-helpers-test-'))
  reviewerLogPath = resolve(dir, 'reviewer-log.jsonl')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('shouldRunCompaction (fix-bot pre-Claude gate)', () => {
  it('reports below-threshold when totalSignal < min, even with DRY_RUN=1 (threshold-first ordering)', () => {
    // Counterfactual: if the impl reversed the order (dry-run check first),
    // this would report `reason: 'dry-run'` and mask the below-threshold
    // signal. The distinction matters: the operator running DRY_RUN=1 to
    // preview cron behavior needs to see "not enough signal" separately
    // from "you asked for dry-run" — different observability notices.
    const outcome = shouldRunCompaction({
      entryCount: 1,
      reviewerLogCount: 1,
      minEntriesForCompaction: 3,
      dryRun: true,
    })
    expect(outcome).toEqual({
      run: false,
      reason: 'below-threshold',
      totalSignal: 2,
      threshold: 3,
    })
  })

  it('sums skip-list entries + reviewer-log entries against threshold (not max, not skip-list-only)', () => {
    // Counterfactual: if the impl used `Math.max(entryCount, reviewerLogCount)`,
    // this would report below-threshold because neither singly reaches 3.
    // Reported `run: true` proves the SUM reaches the threshold — the
    // documented "either signal is enough" semantics per the const's docblock.
    const outcome = shouldRunCompaction({
      entryCount: 2,
      reviewerLogCount: 1,
      minEntriesForCompaction: 3,
      dryRun: false,
    })
    expect(outcome).toEqual({ run: true })
  })

  it('blocks Claude invocation with reason=dry-run when threshold met and DRY_RUN set', () => {
    // Counterfactual: if the impl ignored `dryRun`, `run` would be true
    // and the caller would spend Claude API budget on a run the operator
    // asked to preview. DRY_RUN is the operator's escape hatch to see
    // "would I invoke Claude?" without actually invoking.
    const outcome = shouldRunCompaction({
      entryCount: 5,
      reviewerLogCount: 5,
      minEntriesForCompaction: 3,
      dryRun: true,
    })
    expect(outcome).toEqual({ run: false, reason: 'dry-run' })
  })

  it('proceeds (run: true) exactly at the threshold — uses strict less-than, not less-than-or-equal', () => {
    // Counterfactual: if the impl used `totalSignal <= min`, this would
    // report below-threshold at exactly the minimum documented signal.
    // The compactor would refuse to run at its own documented minimum,
    // which is user-hostile and doesn't match the const's docblock
    // ("Below this we exit early" — implying at/above proceeds).
    const outcome = shouldRunCompaction({
      entryCount: 3,
      reviewerLogCount: 0,
      minEntriesForCompaction: 3,
      dryRun: false,
    })
    expect(outcome).toEqual({ run: true })
  })

  it('proceeds when threshold met and DRY_RUN off (the golden path)', () => {
    // Counterfactual: if the impl always returned `run: false` (e.g.,
    // a refactor accidentally hardcoded the block branch), the monthly
    // cron would silently never invoke Claude. This test pins the
    // happy path so a broken gate can't ship green.
    const outcome = shouldRunCompaction({
      entryCount: 5,
      reviewerLogCount: 3,
      minEntriesForCompaction: 3,
      dryRun: false,
    })
    expect(outcome).toEqual({ run: true })
  })
})

describe('composePrompt (fix-bot compact prompt template)', () => {
  it('includes all six documented variables from prompts/compact.md Inputs section', () => {
    // Counterfactual: if a future refactor dropped any one variable
    // (e.g. REVIEWER_LOG_JSON), Claude would silently produce lower-
    // quality output — no error surface, just less signal. This test
    // catches the drop at CI time, not at monthly-cron time.
    const prompt = composePrompt({
      promptTemplate: 'TEMPLATE_BODY_MARKER',
      skipListPath: 'bots/fix-bot/skip-list.json',
      lessonsPath: 'bots/fix-bot/lessons-learned.md',
      skipList: { version: 1, entries: [{ issueNumber: 42 }], rules: [] },
      reviewerLog: [{ verdict: 'reject', reasoning: 'sample' }],
      lessonsContent: '# Previous lessons body',
      runId: 'run-12345',
    })

    // Template body prepended (the prompt starts with compact.md content).
    expect(prompt).toContain('TEMPLATE_BODY_MARKER')

    // Six documented variables — each labeled + non-empty content.
    expect(prompt).toContain('SKIP_LIST_PATH=bots/fix-bot/skip-list.json')
    expect(prompt).toContain('LESSONS_PATH=bots/fix-bot/lessons-learned.md')
    expect(prompt).toContain('SKIP_LIST_JSON=')
    expect(prompt).toContain('"issueNumber": 42') // proves skipList was serialized, not dropped
    expect(prompt).toContain('REVIEWER_LOG_JSON=')
    expect(prompt).toContain('"verdict": "reject"') // proves reviewerLog was serialized
    expect(prompt).toContain('PREVIOUS_LESSONS=')
    expect(prompt).toContain('# Previous lessons body')
    expect(prompt).toContain('RUN_ID=run-12345')
  })

  it('serializes skip-list + reviewer-log with 2-space indentation, not single-line JSON', () => {
    // Counterfactual: if a refactor called `JSON.stringify(x)` (no
    // indent arg) instead of `JSON.stringify(x, null, 2)`, the JSON
    // would collapse to one line. Claude parses indented structure
    // more reliably — this is not incidental formatting, it's a
    // documented reliability choice (compact.ts line 122-123 comments
    // don't say this, but the sibling handlePostClaude tests establish
    // the pattern of pinning intentional serialization choices).
    const prompt = composePrompt({
      promptTemplate: '',
      skipListPath: 'x',
      lessonsPath: 'y',
      skipList: { version: 1, entries: [{ issueNumber: 42 }], rules: [] },
      reviewerLog: [],
      lessonsContent: '',
      runId: 'r',
    })

    // Pretty-print puts opening `{` on its own line and indents keys
    // with 2 spaces. Single-line output would render as
    // `{"version":1,"entries":[...]}` on one line.
    expect(prompt).toMatch(/SKIP_LIST_JSON=\{\n {2}"version": 1/)
  })

  it('handles empty inputs — empty template, empty JSON structures, empty lessons — without crashing or dropping variable labels', () => {
    // Counterfactual: if the impl assumed non-empty inputs (e.g., used
    // `if (skipList.entries.length)` to gate the SKIP_LIST_JSON line),
    // an empty skip-list would produce a malformed prompt missing the
    // variable label — Claude would see REVIEWER_LOG_JSON where it
    // expected SKIP_LIST_JSON. Empty-input handling is a boundary
    // condition worth pinning.
    const prompt = composePrompt({
      promptTemplate: '',
      skipListPath: 'sk',
      lessonsPath: 'ln',
      skipList: { version: 1, entries: [], rules: [] },
      reviewerLog: [],
      lessonsContent: '',
      runId: 'local',
    })

    // Every label present even with empty values.
    expect(prompt).toContain('SKIP_LIST_PATH=sk')
    expect(prompt).toContain('LESSONS_PATH=ln')
    expect(prompt).toContain('SKIP_LIST_JSON=')
    expect(prompt).toContain('REVIEWER_LOG_JSON=')
    expect(prompt).toContain('PREVIOUS_LESSONS=')
    expect(prompt).toContain('RUN_ID=local')
    // JSON.stringify of an empty array is `[]`; of an empty skip-list
    // shape is a multi-line object with empty arrays.
    expect(prompt).toContain('REVIEWER_LOG_JSON=[]')
  })
})

describe('handlePostClaude (fix-bot compact post-Claude prune)', () => {
  it('Claude failed → no prune; reviewer-log preserved for next month retry', () => {
    seedReviewerLog(500)

    const outcome = handlePostClaude({
      claudeSucceeded: false,
      reviewerLogPath,
      keepLast: 200,
    })

    expect(outcome).toEqual({ prune: null })
    // Counterfactual: if the impl ignored `claudeSucceeded` and pruned
    // unconditionally, the file would drop to 200 entries here. 500
    // proves the branch is honored — this is the load-bearing invariant
    // (a failed run must not evict its own input, or next month's
    // retry loses the failing signal).
    expect(readReviewerLog(reviewerLogPath)).toHaveLength(500)
  })

  it('Claude succeeded → prune runs and honors keepLast parameter', () => {
    seedReviewerLog(500)

    const outcome = handlePostClaude({
      claudeSucceeded: true,
      reviewerLogPath,
      keepLast: 200,
    })

    // Counterfactual: if the impl hardcoded a keep value (e.g., 100),
    // `dropped` would be 400 not 300. The exact 300/200 split pins
    // that keepLast is threaded through, not shadowed.
    expect(outcome).toEqual({ prune: { dropped: 300, kept: 200 } })
    expect(readReviewerLog(reviewerLogPath)).toHaveLength(200)
  })

  it('Claude succeeded + reviewer-log under keepLast → prune returns {dropped: 0, kept: N}, not null', () => {
    seedReviewerLog(50)

    const outcome = handlePostClaude({
      claudeSucceeded: true,
      reviewerLogPath,
      keepLast: 200,
    })

    // Counterfactual: if the impl returned `{prune: null}` when
    // under-threshold, the caller's `outcome.prune ? ... : ...` branch
    // would fall through to the "Claude did not succeed" notice —
    // wrong branch entirely. The `{dropped: 0, kept: 50}` shape being
    // present (not null) proves prune WAS invoked and reported no-op.
    expect(outcome).toEqual({ prune: { dropped: 0, kept: 50 } })
    expect(readReviewerLog(reviewerLogPath)).toHaveLength(50)
  })

  it('Claude succeeded + missing reviewer-log file → prune returns {dropped: 0, kept: 0}, not null', () => {
    // Deliberately do NOT seed the reviewer-log. Boundary condition:
    // the first successful compaction run on a fresh bot install
    // hits this — the file doesn't exist yet because no Agent B has
    // ever written to it. pruneReviewerLog tolerates the absent file
    // (per its `if (!existsSync) return []` branch) and returns 0/0.

    const outcome = handlePostClaude({
      claudeSucceeded: true,
      reviewerLogPath,
      keepLast: 200,
    })

    // Counterfactual: if the impl threw on missing file, we'd never
    // reach this assertion. The `{prune: {dropped: 0, kept: 0}}` shape
    // proves prune was invoked, treated absent as zero-entries, and
    // returned normally.
    expect(outcome).toEqual({ prune: { dropped: 0, kept: 0 } })
  })
})
