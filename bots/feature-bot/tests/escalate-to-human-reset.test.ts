/**
 * `escalateToHuman` must reset to a clean main BEFORE it records the skip
 * entry and branches the skip-list PR. Callers can still be on
 * `feat/cut-N` (the reviewer-failure path was), and the skip branch is cut
 * from HEAD, so a missing reset ships the cut's unreviewed commits inside
 * the skip-list PR (#892). fix-bot fixed the same bug earlier and pinned it
 * (fix-bot/tests/escalate-to-human-reset.test.ts); this is the rule-38
 * mirror.
 *
 * Order matters both ways: the reset runs `git reset --hard`, so it must
 * also come BEFORE the skip-list write or it discards it.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'), 'utf-8')
const start = src.indexOf('async function escalateToHuman(')
const body = src.slice(start, src.indexOf('\n}\n', start))

describe('escalateToHuman — reset first', () => {
  it('resets the cut branch to main', () => {
    expect(start).toBeGreaterThan(-1)
    expect(body).toMatch(/resetToMain\(cutBranch\(issueNumber\)/)
  })

  it('resets before writing the skip list and before branching', () => {
    const reset = body.indexOf('resetToMain(')
    expect(reset).toBeLessThan(body.indexOf('writeSkipList('))
    expect(reset).toBeLessThan(body.indexOf("'checkout', '-b'"))
  })

  it('resets the same branch the loop builds', () => {
    expect(src).toMatch(/const branchName = cutBranch\(issueNumber\)/)
  })
})
