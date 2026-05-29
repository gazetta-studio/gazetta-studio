import { describe, expect, it, vi } from 'vitest'
import { getLabelAppliedAt, getReopenedAt, removeLabel } from '../github.js'

const REPO = { owner: 'gazetta-studio', repo: 'gazetta-studio' }

/**
 * Build a fake octokit. `currentLabels` is the issue's CURRENT labels
 * (what `issues.get` returns); `events` is the historical timeline.
 *
 * The default `currentLabels` infers from the events — every `labeled`
 * minus every later `unlabeled` for the same name. Tests that don't
 * care about the current-state check can omit `currentLabels` and get
 * the "current state matches history" behaviour.
 */
function makeOctokit(
  events: Array<{ event: string; label?: { name: string }; created_at: string }>,
  currentLabels?: string[],
) {
  const inferredLabels: string[] = (() => {
    const set = new Set<string>()
    for (const ev of events) {
      if (!ev.label) continue
      if (ev.event === 'labeled') set.add(ev.label.name)
      else if (ev.event === 'unlabeled') set.delete(ev.label.name)
    }
    return [...set]
  })()
  const labels = currentLabels ?? inferredLabels
  return {
    issues: {
      get: vi
        .fn()
        .mockResolvedValue({ data: { labels: labels.map(name => ({ name })), created_at: '2026-05-01T00:00:00Z' } }),
      listEvents: vi.fn().mockResolvedValue({ data: events }),
      removeLabel: vi.fn().mockResolvedValue({}),
    },
  } as never
}

function makeOctokitWith(removeLabelImpl: (input: unknown) => unknown) {
  return {
    issues: {
      removeLabel: vi.fn().mockImplementation(removeLabelImpl),
    },
  } as never
}

describe('getLabelAppliedAt', () => {
  it('returns null when the label has never been applied', async () => {
    const octokit = makeOctokit([
      { event: 'labeled', label: { name: 'bug' }, created_at: '2026-05-01T10:00:00Z' },
      { event: 'commented', created_at: '2026-05-01T11:00:00Z' },
    ])
    const result = await getLabelAppliedAt(octokit, REPO, 288, 'fix-bot-attempted')
    expect(result).toBeNull()
  })

  it('returns the timestamp when the label was applied', async () => {
    const octokit = makeOctokit([
      { event: 'labeled', label: { name: 'bug' }, created_at: '2026-05-01T10:00:00Z' },
      { event: 'labeled', label: { name: 'fix-bot-attempted' }, created_at: '2026-05-11T16:00:00Z' },
    ])
    const result = await getLabelAppliedAt(octokit, REPO, 288, 'fix-bot-attempted')
    expect(result).toBe('2026-05-11T16:00:00Z')
  })

  it('returns the MOST RECENT labeled event when the label was added twice', async () => {
    // Maintainer removed + bot re-applied; we want the latest application
    // for the reopened-since-attempt comparison to be honest.
    const octokit = makeOctokit([
      { event: 'labeled', label: { name: 'fix-bot-attempted' }, created_at: '2026-05-10T08:00:00Z' },
      { event: 'unlabeled', label: { name: 'fix-bot-attempted' }, created_at: '2026-05-10T12:00:00Z' },
      { event: 'labeled', label: { name: 'fix-bot-attempted' }, created_at: '2026-05-11T08:00:00Z' },
    ])
    const result = await getLabelAppliedAt(octokit, REPO, 288, 'fix-bot-attempted')
    expect(result).toBe('2026-05-11T08:00:00Z')
  })

  it('does not confuse different label names', async () => {
    // A `ready-for-human` labeled event at the latest position must not be
    // returned when querying for `fix-bot-attempted`.
    const octokit = makeOctokit([
      { event: 'labeled', label: { name: 'fix-bot-attempted' }, created_at: '2026-05-11T08:00:00Z' },
      { event: 'labeled', label: { name: 'ready-for-human' }, created_at: '2026-05-11T09:00:00Z' },
    ])
    const result = await getLabelAppliedAt(octokit, REPO, 288, 'fix-bot-attempted')
    expect(result).toBe('2026-05-11T08:00:00Z')
  })

  it('returns null when the label was applied historically but is NOT currently on the issue', async () => {
    // Regression for the 2026-05-29 bug. After fix-bot's first attempt on
    // #414 and #415 (May 23), the bot recorded `fix-bot-attempted`. On
    // May 29 the maintainer removed the label to allow a retry. The
    // helper kept returning the historical "labeled" timestamp because
    // it only walked timeline events without checking the current label
    // set — and the orchestrator's idempotency check (`if (attemptedAt)`)
    // treated that as "label present, do not retry."
    //
    // Fix: check the issue's current labels first; only walk the timeline
    // if the label is actually applied today.
    const octokit = makeOctokit(
      [
        { event: 'labeled', label: { name: 'fix-bot-attempted' }, created_at: '2026-05-23T06:54:00Z' },
        { event: 'unlabeled', label: { name: 'fix-bot-attempted' }, created_at: '2026-05-29T13:44:00Z' },
      ],
      ['bug', 'ready-for-agent'], // current labels — fix-bot-attempted has been removed
    )
    const result = await getLabelAppliedAt(octokit, REPO, 288, 'fix-bot-attempted')
    expect(result).toBeNull()
  })

  it('returns the latest labeled timestamp when label was removed and re-applied', async () => {
    // Maintainer removed → bot re-applied. Label IS currently on the
    // issue. Should return the LATEST labeled event so the
    // reopened-since-attempt comparison uses the right anchor.
    const octokit = makeOctokit(
      [
        { event: 'labeled', label: { name: 'fix-bot-attempted' }, created_at: '2026-05-23T06:54:00Z' },
        { event: 'unlabeled', label: { name: 'fix-bot-attempted' }, created_at: '2026-05-29T13:44:00Z' },
        { event: 'labeled', label: { name: 'fix-bot-attempted' }, created_at: '2026-05-29T14:15:00Z' },
      ],
      // `currentLabels` defaults to the inferred set from the events;
      // after labeled→unlabeled→labeled the inferred set has it.
    )
    const result = await getLabelAppliedAt(octokit, REPO, 288, 'fix-bot-attempted')
    expect(result).toBe('2026-05-29T14:15:00Z')
  })
})

describe('getReopenedAt', () => {
  it('returns null when the issue has never been reopened', async () => {
    const octokit = makeOctokit([
      { event: 'labeled', label: { name: 'bug' }, created_at: '2026-05-01T10:00:00Z' },
      { event: 'closed', created_at: '2026-05-05T10:00:00Z' },
    ])
    const result = await getReopenedAt(octokit, REPO, 288)
    expect(result).toBeNull()
  })

  it('returns the timestamp of the most recent reopen', async () => {
    const octokit = makeOctokit([
      { event: 'closed', created_at: '2026-05-05T10:00:00Z' },
      { event: 'reopened', created_at: '2026-05-06T10:00:00Z' },
      { event: 'closed', created_at: '2026-05-08T10:00:00Z' },
      { event: 'reopened', created_at: '2026-05-11T17:00:00Z' },
    ])
    const result = await getReopenedAt(octokit, REPO, 288)
    expect(result).toBe('2026-05-11T17:00:00Z')
  })

  it('reopen-after-attempt scenario: reopen newer than label = retry signal', async () => {
    // The load-bearing case for auto-clear-on-reopen:
    // attempt at T1, close at T2, reopen at T3 (T1 < T3) → cron should retry.
    const events = [
      { event: 'labeled', label: { name: 'fix-bot-attempted' }, created_at: '2026-05-11T16:00:00Z' },
      { event: 'closed', created_at: '2026-05-11T16:30:00Z' }, // auto-close from merged PR
      { event: 'reopened', created_at: '2026-05-11T17:00:00Z' },
    ]
    const octokit = makeOctokit(events)
    const attemptedAt = await getLabelAppliedAt(octokit, REPO, 288, 'fix-bot-attempted')
    const reopenedAt = await getReopenedAt(octokit, REPO, 288)
    expect(reopenedAt).not.toBeNull()
    expect(attemptedAt).not.toBeNull()
    // Lexical string comparison works for ISO 8601 in UTC.
    expect(reopenedAt! > attemptedAt!).toBe(true)
  })

  it('reopen-before-attempt scenario: label newer than reopen = no retry', async () => {
    // Maintainer reopened, then bot ran successfully, applied label.
    // Subsequent cron should NOT retry — the most recent signal is "bot tried."
    const events = [
      { event: 'reopened', created_at: '2026-05-11T16:00:00Z' },
      { event: 'labeled', label: { name: 'fix-bot-attempted' }, created_at: '2026-05-11T16:30:00Z' },
    ]
    const octokit = makeOctokit(events)
    const attemptedAt = await getLabelAppliedAt(octokit, REPO, 288, 'fix-bot-attempted')
    const reopenedAt = await getReopenedAt(octokit, REPO, 288)
    expect(reopenedAt! > attemptedAt!).toBe(false)
  })
})

describe('removeLabel', () => {
  it('returns true when the label was present and removed', async () => {
    const octokit = makeOctokitWith(() => Promise.resolve({}))
    const result = await removeLabel(octokit, REPO, 288, 'fix-bot-attempted')
    expect(result).toBe(true)
  })

  it('returns false when the label was not present (404)', async () => {
    const octokit = makeOctokitWith(() => Promise.reject(Object.assign(new Error('Not Found'), { status: 404 })))
    const result = await removeLabel(octokit, REPO, 288, 'fix-bot-attempted')
    expect(result).toBe(false)
  })

  it('throws on non-404 errors (auth, network)', async () => {
    const octokit = makeOctokitWith(() => Promise.reject(Object.assign(new Error('Forbidden'), { status: 403 })))
    await expect(removeLabel(octokit, REPO, 288, 'fix-bot-attempted')).rejects.toThrow('Forbidden')
  })
})
