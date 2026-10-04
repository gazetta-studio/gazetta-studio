/**
 * Every memoryful bot's daily workflow and its `bots-compact.yml` job must
 * share one cache key family, via the restore/save split.
 *
 * The failure this pins (#854) is silent: the compactor jobs once used the
 * combined `actions/cache@v6` with a static exact key, while the daily bots
 * save `<bot>-...-v1-<run_id>`. The keys never met, so each compactor
 * rewrote lessons-learned.md from a stale log — no error, just wrong input,
 * for months.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const WF = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.github', 'workflows')
const read = (f: string) => readFileSync(resolve(WF, f), 'utf-8')

/** The `bots-compact.yml` job body for one bot (up to the next top-level job). */
function compactJob(bot: string): string {
  const src = read('bots-compact.yml')
  const start = src.indexOf(`\n  ${bot}:\n`)
  if (start === -1) throw new Error(`no ${bot} job in bots-compact.yml`)
  const rest = src.slice(start + 1)
  const next = rest.slice(1).search(/\n {2}[a-z][a-z-]*:\n/)
  return next === -1 ? rest : rest.slice(0, next + 1)
}

const PAIRS = [
  { bot: 'dead-code-watcher', daily: 'dead-code-watcher.yml', prefix: 'dead-code-watcher-reviewer-log-v1-' },
  { bot: 'fix-bot', daily: 'fix-bot.yml', prefix: 'fix-bot-reviewer-log-v1-' },
  { bot: 'review-bot', daily: 'review-bot.yml', prefix: 'review-bot-reviewer-log-v1-' },
  { bot: 'cut-planner', daily: 'cut-planner.yml', prefix: 'cut-planner-decision-log-v1-' },
]

describe.each(PAIRS)('$bot — daily ↔ compactor cache wiring', ({ bot, daily, prefix }) => {
  const restoreKeys = new RegExp(`restore-keys: \\|\\n\\s+${prefix.replace(/[-]/g, '\\-')}\\n`)
  const saveKey = `key: ${prefix}\${{ github.run_id }}`

  it('the daily workflow restores via the prefix and saves per run', () => {
    const d = read(daily)
    expect(d).toMatch(restoreKeys)
    expect(d).toContain(saveKey)
  })

  it('the compactor uses the same split and key family', () => {
    const job = compactJob(bot)
    expect(job).toContain('actions/cache/restore@')
    expect(job).toContain('actions/cache/save@')
    expect(job).toMatch(restoreKeys)
    expect(job).toContain(saveKey)
  })

  it('the compactor never uses the combined action (skips its save on a hit, #581)', () => {
    expect(compactJob(bot)).not.toMatch(/uses: actions\/cache@/)
  })
})
