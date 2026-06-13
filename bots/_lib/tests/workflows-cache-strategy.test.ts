/**
 * Pins the reviewer-log cache strategy across all four memoryful-bot
 * workflows. `actions/cache@v4`/`@v5` skips its post-step save on a
 * cache HIT against the primary key — by design, but it breaks the
 * append-write-back pattern the bots rely on (every run after the
 * first reads N entries, appends 1, but never persists the new entry
 * because the primary key already exists). See issue #581.
 *
 * The fix is the standard `restore` + `save` split with a per-run
 * unique save key, so every run produces its own immutable cache
 * entry and the restore step finds the latest via `restore-keys`
 * prefix match.
 *
 * These tests fail before the fix (every workflow uses the single
 * combined `actions/cache@v4` shape) and pass after.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..', '..')

const BOTS = [
  { name: 'fix-bot', logPath: 'bots/fix-bot/reviewer-log.jsonl' },
  { name: 'dead-code-watcher', logPath: 'bots/dead-code-watcher/reviewer-log.jsonl' },
  { name: 'review-bot', logPath: 'bots/review-bot/reviewer-log.jsonl' },
  { name: 'mutation-area-picker', logPath: 'bots/mutation-area-picker/reviewer-log.jsonl' },
] as const

describe('memoryful bots — reviewer-log cache strategy', () => {
  for (const bot of BOTS) {
    describe(bot.name, () => {
      const yaml = readFileSync(resolve(REPO, '.github', 'workflows', `${bot.name}.yml`), 'utf-8')

      it('uses actions/cache/restore (not combined actions/cache) for the reviewer-log', () => {
        // The combined `actions/cache@vN` step skips save on cache-hit.
        // Issue #581 — using the split restore/save pair is the fix.
        const restoresLog = /uses:\s*actions\/cache\/restore@v\d+[\s\S]{0,200}reviewer-log\.jsonl/.test(yaml)
        expect(restoresLog, `${bot.name}.yml must restore the reviewer-log via actions/cache/restore@vN`).toBe(true)
      })

      it('has an always-running actions/cache/save step for the reviewer-log', () => {
        // The save step must use `if: always()` so it runs even when
        // the bot run itself fails — losing the log on bot-failure
        // would silently lose Agent B verdicts that informed the
        // failure path.
        const savesLog =
          /uses:\s*actions\/cache\/save@v\d+[\s\S]{0,400}reviewer-log\.jsonl/.test(yaml) &&
          /if:\s*always\(\)/.test(yaml)
        expect(savesLog, `${bot.name}.yml must save the reviewer-log via actions/cache/save@vN with if: always()`).toBe(
          true,
        )
      })

      it('uses a per-run save key (run-id or run-attempt suffix)', () => {
        // Per-run keys make every save succeed (the primary key is
        // unique). The restore step finds the latest via restore-keys
        // prefix match. Without a per-run suffix, the same cache-hit-
        // skip-save trap returns.
        const savesWithPerRunKey =
          /uses:\s*actions\/cache\/save@v\d+[\s\S]{0,400}key:\s*[^\n]*\$\{\{\s*github\.run_id\s*\}\}/.test(yaml)
        expect(
          savesWithPerRunKey,
          `${bot.name}.yml save step must use a per-run key (e.g. {bot}-reviewer-log-v1-\${{ github.run_id }})`,
        ).toBe(true)
      })

      it('declares restore-keys prefix-match for cross-run lookup', () => {
        // Restore must match against the static prefix so a run can
        // find the most-recently-written entry from any prior run.
        // Without restore-keys, every run starts with an empty log.
        expect(yaml, `${bot.name}.yml restore step must declare restore-keys for prefix match`).toMatch(
          /restore-keys:\s*\|?[\s\S]{0,200}reviewer-log-v1/,
        )
      })

      it('does NOT use the combined actions/cache@vN for the reviewer-log', () => {
        // Belt-and-suspenders: the combined `actions/cache@vN` shape
        // is the broken pattern. Even if restore+save are also
        // declared, leaving the combined step would still hit the
        // cache-hit-skip-save trap on its own save invocation.
        const combinedShape = new RegExp(`uses:\\s*actions/cache@v\\d+[\\s\\S]{0,200}reviewer-log\\.jsonl`)
        expect(combinedShape.test(yaml), `${bot.name}.yml must not use combined actions/cache@vN`).toBe(false)
      })
    })
  }
})
