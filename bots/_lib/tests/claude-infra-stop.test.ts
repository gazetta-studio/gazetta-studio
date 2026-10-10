/**
 * `detectInfraStop` — "this agent stopped for infrastructure reasons, come
 * back later" — must recognise the real reviewer quota failure that parked
 * #519 as needs-human (run 37770034162, #892), and must NOT fire on an
 * ordinary failure, which still has to escalate.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectInfraStop } from '../claude.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-infra-stop-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function transcript(lines: object[]): string {
  const path = join(dir, 'transcript.jsonl')
  writeFileSync(path, `${lines.map(o => JSON.stringify(o)).join('\n')}\n`)
  return path
}

describe('detectInfraStop', () => {
  it('fires on the real #519 Agent B quota failure (events copied from run 37770034162)', () => {
    const path = transcript([
      { type: 'system', subtype: 'init', session_id: 's' },
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.98 },
      },
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', overageStatus: 'rejected' },
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: true,
        api_error_status: 429,
        result: "You've hit your session limit · resets 4:10pm (UTC)",
      },
    ])
    expect(detectInfraStop(path)).toBe(true)
  })

  it('fires on a transient auth failure (403)', () => {
    const path = transcript([
      { type: 'result', subtype: 'success', is_error: true, api_error_status: 403, result: 'Forbidden' },
    ])
    expect(detectInfraStop(path)).toBe(true)
  })

  it('does not fire on an ordinary failure, which must still escalate', () => {
    const path = transcript([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'running the tests' }] } },
      { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'spawn E2BIG' },
    ])
    expect(detectInfraStop(path)).toBe(false)
  })

  it('does not fire when the transcript is missing', () => {
    expect(detectInfraStop(join(dir, 'nope.jsonl'))).toBe(false)
  })
})
