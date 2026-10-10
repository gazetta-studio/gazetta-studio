/**
 * Every bot that runs a reviewer (Agent B) must check for an infrastructure
 * stop BEFORE treating a failed review as a crash. Without it, a session
 * limit hit during review becomes a terminal needs-human (#892: #519 parked
 * this way). Adding the check to only one bot is the rule-38 miss that let
 * this sit in three bots, so the scan covers all of them.
 *
 * Source-level on purpose: the guard sits inside each bot's orchestration
 * loop, which has no seam to call without GitHub and Claude. The drift it
 * catches — a new reviewer call or refactor dropping the check — is the
 * kind that happens without noticing (rule 41).
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const BOTS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

describe.each(['feature-bot', 'fix-bot', 'dead-code-watcher'])('%s', bot => {
  const src = readFileSync(resolve(BOTS, bot, 'index.ts'), 'utf-8')

  it('checks detectInfraStop on the reviewer transcript before the generic failure branch', () => {
    const guard = src.indexOf('!bResult.success && detectInfraStop(reviewerTranscript)')
    const generic = src.indexOf('if (!bResult.success) {')
    expect(guard, 'infra-stop guard missing').toBeGreaterThan(-1)
    expect(generic, 'generic failure branch missing').toBeGreaterThan(-1)
    expect(guard).toBeLessThan(generic)
  })
})
