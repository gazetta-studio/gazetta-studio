/**
 * Transient auth / entitlement detection on Claude transcripts.
 *
 * Sibling to `claude-rate-limit.test.ts` (rule 38 symmetry). Same
 * category — "the cut is fine, the infrastructure isn't" — different
 * signal: a 401 / 403 from Anthropic rather than a 429 rate-limit.
 *
 * Why this exists: without detection, a momentary org-level auth blip
 * makes Agent A exit non-zero, which routes to `agent-a-failure` →
 * `escalate-failure` → a TERMINAL `needs-human` skip-list entry +
 * `ready-for-human` + closed issue. That is what happened to cut #524
 * on 2026-06-24 ("Your organization has disabled Claude subscription
 * access for Claude Code"): auth was working again by 07-02, but the
 * skip-list entry made the cut permanently invisible to the cron, and
 * it blocked the entire review-workflow dependency chain (#522, #523,
 * #535 → #525, #528, #529) for three months.
 *
 * Pins:
 *   - true on an `api_error_status: 403` result event
 *   - true on an `api_error_status: 401` result event
 *   - true on the observed prose wording when no status code is present
 *     (the June transcripts aged out of 90-day retention before the
 *     exact field shape could be confirmed — match both defensively)
 *   - FALSE on a 429 (that's `detectRateLimit`'s job — the two signals
 *     stay independently testable)
 *   - FALSE on a 500 / other server error (escalate those normally)
 *   - FALSE on an unrelated 403 the AGENT hit via a tool call (e.g. a
 *     curl in Bash) — that must not mask a real code-level failure as
 *     transient infra
 *   - FALSE on success / missing / malformed transcripts (defensive)
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectTransientAuthError } from '../claude.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-transient-auth-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeTranscript(lines: object[]): string {
  const path = join(dir, 'transcript.jsonl')
  writeFileSync(path, lines.map(o => JSON.stringify(o)).join('\n') + '\n')
  return path
}

describe('detectTransientAuthError', () => {
  it('returns true on a 403 result event (the #524 failure mode)', () => {
    const path = writeTranscript([
      { type: 'system', subtype: 'init', session_id: 's1' },
      {
        type: 'result',
        subtype: 'success',
        is_error: true,
        api_error_status: 403,
        result: 'Your organization has disabled Claude subscription access for Claude Code',
      },
    ])
    expect(detectTransientAuthError(path)).toBe(true)
  })

  it('returns true on a 401 result event', () => {
    const path = writeTranscript([
      { type: 'system', subtype: 'init', session_id: 's2' },
      { type: 'result', subtype: 'success', is_error: true, api_error_status: 401 },
    ])
    expect(detectTransientAuthError(path)).toBe(true)
  })

  it('returns true on the observed prose wording with NO status code', () => {
    // Defensive: the June 2026 transcripts aged out of retention before
    // the exact field shape could be confirmed, so the detector also
    // matches the entitlement wording.
    const path = writeTranscript([
      { type: 'system', subtype: 'init', session_id: 's3' },
      {
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'Your organization has disabled Claude subscription access for Claude Code',
      },
    ])
    expect(detectTransientAuthError(path)).toBe(true)
  })

  it('returns FALSE on a 429 — that is detectRateLimit’s signal, not this one', () => {
    const path = writeTranscript([
      { type: 'system', subtype: 'init', session_id: 's4' },
      {
        type: 'result',
        subtype: 'success',
        is_error: true,
        api_error_status: 429,
        result: "You've hit your session limit · resets 11:20am (UTC)",
      },
    ])
    expect(detectTransientAuthError(path)).toBe(false)
  })

  it('returns FALSE on a 500 / other server error (escalate those normally)', () => {
    const path = writeTranscript([
      { type: 'system', subtype: 'init', session_id: 's5' },
      { type: 'result', subtype: 'success', is_error: true, api_error_status: 500 },
    ])
    expect(detectTransientAuthError(path)).toBe(false)
  })

  it('returns FALSE when the AGENT hit a 403 via a tool call, not Anthropic', () => {
    // A curl/gh 403 inside the agent's own work is a code-level problem
    // for the cut to solve — it must NOT be laundered into "transient
    // infra", which would leave a genuinely-failing cut cycling forever.
    const path = writeTranscript([
      { type: 'system', subtype: 'init', session_id: 's6' },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', content: 'HTTP 403 Forbidden from api.example.com' }] },
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'The upstream API returned 403 Forbidden; could not complete the fixture setup.',
      },
    ])
    expect(detectTransientAuthError(path)).toBe(false)
  })

  it('returns false on a normal success transcript', () => {
    const path = writeTranscript([
      { type: 'system', subtype: 'init', session_id: 's7' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
      { type: 'result', subtype: 'success', is_error: false },
    ])
    expect(detectTransientAuthError(path)).toBe(false)
  })

  it('returns false when the transcript file does not exist (defensive)', () => {
    expect(detectTransientAuthError(join(dir, 'nope.jsonl'))).toBe(false)
  })

  it('returns false on a malformed transcript with non-JSON lines (defensive)', () => {
    const path = join(dir, 'transcript.jsonl')
    writeFileSync(path, 'not json\n{not even close\nstill not\n')
    expect(detectTransientAuthError(path)).toBe(false)
  })
})
