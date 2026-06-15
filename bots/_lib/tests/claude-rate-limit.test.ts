/**
 * Rate-limit detection on Claude transcripts.
 *
 * When `claude -p` exits 1 because of Anthropic's session-rate-limit
 * (5-hour bucket exhausted), the transcript ends with both a
 * `rate_limit_event` with `status: rejected` AND a `result` event
 * with `api_error_status: 429`. The first event of every cascading
 * subsequent failed cut is the same `rate_limit_event`.
 *
 * The bot orchestrator needs to detect this so it can STOP its
 * candidate loop instead of cascading more crashes. Without
 * detection, one 429 spawns N spurious skip-list PRs (#587-#590
 * on 2026-06-14 — all four were rate-limit cascade victims of
 * Cut #519's expensive run, not real "needs-human" outcomes).
 *
 * Pins:
 *   - `detectRateLimit` returns true when the transcript ends with
 *     a 429 `result` event
 *   - returns true when ANY line has a rejected `rate_limit_event`
 *   - returns false on normal success transcripts
 *   - returns false on non-rate-limit errors (exit due to other
 *     causes — we want to escalate those normally)
 *   - reads the transcript file from disk (matches how the bot
 *     consumes it via `transcriptPath` from `ClaudeResult`)
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectRateLimit } from '../claude.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-rate-limit-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeTranscript(lines: object[]): string {
  const path = join(dir, 'transcript.jsonl')
  writeFileSync(path, lines.map(o => JSON.stringify(o)).join('\n') + '\n')
  return path
}

describe('detectRateLimit', () => {
  it('returns true when the transcript ends with a 429 result event', () => {
    const path = writeTranscript([
      { type: 'system', subtype: 'init', session_id: 's1' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
      {
        type: 'result',
        subtype: 'success',
        is_error: true,
        api_error_status: 429,
        result: "You've hit your session limit · resets 11:20am (UTC)",
      },
    ])
    expect(detectRateLimit(path)).toBe(true)
  })

  it('returns true when ANY line is a rejected rate_limit_event (cascade case)', () => {
    // The 4-second cascade transcripts: first event IS the rejected
    // rate_limit_event before Claude even starts the conversation.
    const path = writeTranscript([
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' },
      },
      { type: 'system', subtype: 'init', session_id: 's2' },
      { type: 'result', subtype: 'success', is_error: true, api_error_status: 429 },
    ])
    expect(detectRateLimit(path)).toBe(true)
  })

  it('returns false on a normal success transcript', () => {
    const path = writeTranscript([
      { type: 'system', subtype: 'init', session_id: 's3' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
      { type: 'result', subtype: 'success', is_error: false },
    ])
    expect(detectRateLimit(path)).toBe(false)
  })

  it('returns false when an allowed_warning rate_limit_event appears (utilization < 1)', () => {
    // Warnings at 90% / 99% utilization should NOT trigger cascade
    // detection — only the explicit rejected status does.
    const path = writeTranscript([
      { type: 'system', subtype: 'init', session_id: 's4' },
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.99 },
      },
      { type: 'result', subtype: 'success', is_error: false },
    ])
    expect(detectRateLimit(path)).toBe(false)
  })

  it('returns false on an error transcript that is NOT rate-limit (other 5xx, network, etc.)', () => {
    const path = writeTranscript([
      { type: 'system', subtype: 'init', session_id: 's5' },
      { type: 'result', subtype: 'success', is_error: true, api_error_status: 500 },
    ])
    expect(detectRateLimit(path)).toBe(false)
  })

  it('returns false when the transcript file does not exist (defensive)', () => {
    expect(detectRateLimit(join(dir, 'nope.jsonl'))).toBe(false)
  })

  it('returns false on a malformed transcript with non-JSON lines (defensive)', () => {
    const path = join(dir, 'transcript.jsonl')
    writeFileSync(path, 'not json\n{not even close\nstill not\n')
    expect(detectRateLimit(path)).toBe(false)
  })
})
