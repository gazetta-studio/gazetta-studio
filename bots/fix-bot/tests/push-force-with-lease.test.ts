import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { extractFunctionBody } from './_helpers/source-scan.ts'

// Pins that every `git push` in fix-bot's orchestrator uses
// `--force-with-lease`. Symmetric-bot audit per team-preferences rule
// 38: feature-bot, review-bot, and mutation-area-picker already push
// with `--force-with-lease` to defeat #550-class stale-branch reuse.
// fix-bot lagged — pushBranch() + the two skip-list-PR pushes used
// plain `git push -u origin`, so on a rerun against a stale leftover
// branch (same fix-bot-skip/{date}-issue-{n} branch name, e.g. two
// runs on the same date) the push would silently fail (best-effort
// try/catch), and openFixPR / the follow-up `gh pr create` would
// proceed against stale commits. prompts/per-issue.md line 509
// already documents `--force-with-lease` as the intended behavior —
// code and doc diverged.

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX_PATH = resolve(HERE, '..', 'index.ts')
const source = readFileSync(INDEX_PATH, 'utf-8')

describe('fix-bot git push uses --force-with-lease', () => {
  it('pushBranch() pushes with --force-with-lease', () => {
    const body = extractFunctionBody(source, 'pushBranch')
    // The single git push call in pushBranch must include the flag.
    expect(body).toMatch(/execFileSync\(\s*'git'\s*,\s*\[[^\]]*'--force-with-lease'[^\]]*\]/)
  })

  it('openPastPRSkipListPR() pushes the skip-list branch with --force-with-lease', () => {
    const body = extractFunctionBody(source, 'openPastPRSkipListPR')
    // openPastPRSkipListPR contains one git push; must include the flag.
    const pushCalls = body.match(/execFileSync\(\s*'git'\s*,\s*\[[^\]]*'push'[^\]]*\]/g) ?? []
    expect(pushCalls.length).toBeGreaterThan(0)
    for (const call of pushCalls) {
      expect(call).toContain("'--force-with-lease'")
    }
  })

  it('escalateToHuman() pushes the skip-list branch with --force-with-lease', () => {
    const body = extractFunctionBody(source, 'escalateToHuman')
    const pushCalls = body.match(/execFileSync\(\s*'git'\s*,\s*\[[^\]]*'push'[^\]]*\]/g) ?? []
    expect(pushCalls.length).toBeGreaterThan(0)
    for (const call of pushCalls) {
      expect(call).toContain("'--force-with-lease'")
    }
  })

  it('no `git push` in index.ts is missing --force-with-lease', () => {
    // Belt-and-suspenders check: catch a future new push call that
    // forgets the flag, even if it's added outside the three known
    // functions above.
    const allPushCalls = source.match(/execFileSync\(\s*'git'\s*,\s*\[[^\]]*'push'[^\]]*\]/g) ?? []
    expect(allPushCalls.length).toBeGreaterThan(0)
    for (const call of allPushCalls) {
      expect(call, `git push missing --force-with-lease: ${call}`).toContain("'--force-with-lease'")
    }
  })
})
