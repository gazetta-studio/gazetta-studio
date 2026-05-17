/**
 * review-bot — autonomous code-improvement producer.
 *
 * Status: SCAFFOLDING ONLY (P4 Cut 17). Pipeline phases 0/1/2/3/4/5
 * are stubbed; subsequent cuts (18, 19) implement them in follow-up
 * sessions with real measurement of Phase 0 scoring weights.
 *
 * Pipeline (per design-code-review.md "Review-bot (autonomous)"):
 *
 *   Phase 0  — Pick an area
 *              TS: score top 5 areas by recency + bot-touched + skip-list
 *              LLM: pick one with one-line context per candidate
 *
 *   Phase 1  — Discovery
 *              Skill: audit-area <picked-area>
 *              Output: ranked candidate improvements
 *
 *   Phase 2  — Pick top candidate
 *              TS: sort by (severity, confidence); skip skip-list matches
 *
 *   Phase 3  — Make the change (Agent A)
 *              Prompt: prompts/agent-a.md with injected candidate +
 *              lessons-learned.md
 *              TDD-first ordering (failing test commit before fix)
 *
 *   Phase 4  — Review the diff (Agent B)
 *              Skill: review-orchestrator on git diff main...improve/<id>
 *              Output: aggregated findings via JSONL fence
 *
 *   Phase 5  — Verdict + action
 *              CRITICAL → REJECT (retry) or NEEDS_HUMAN (log + skip)
 *              IMPORTANT only → REJECT with Note (retry)
 *              NIT only / empty → APPROVE → push branch, open PR
 *
 * Generator-critic pattern matches dead-code-watcher + fix-bot
 * (per ADR-0011 + bots/README.md). Same memory model: skip-list
 * committed to repo; reviewer-log cached via actions/cache;
 * lessons-learned.md committed and rewritten by the monthly
 * compactor.
 *
 * Single-instance invariant: workflow concurrency group 'review-bot'
 * with cancel-in-progress: false (per ADR-0011).
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { printNotice, printWarning } from '../_lib/ui.js'
import { readSkipList } from './skip-list.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKIPLIST_PATH = resolve(HERE, 'skip-list.json')

async function main(): Promise<void> {
  const dryRun = process.env.DRY_RUN === '1'

  printNotice('review-bot — scaffolding-only (P4 Cut 17).')
  printNotice('Pipeline phases 0/1/2/3/4/5 are stubbed; cuts 18+19 will implement.')

  const skipList = readSkipList(SKIPLIST_PATH)
  printNotice(`Skip-list: ${skipList.entries.length} entries, ${skipList.rules.length} rules.`)

  if (dryRun) {
    printNotice('DRY_RUN=1: scaffolding-only invocation; no work to do.')
    process.exit(0)
  }

  // STUB: Phase 0 area pick is not yet implemented.
  // STUB: Phase 1 audit-area invocation is not yet implemented.
  // STUB: Phase 2-5 generator-critic loop is not yet implemented.
  // Each phase lands in cuts 18 and 19; see design-code-review-
  // implementation.md P4 section.
  printWarning('review-bot scaffolding is not yet a complete pipeline.')
  printWarning('Exiting cleanly without taking any action.')
  printWarning('When cuts 18-19 land, this stub becomes the real entry point.')

  process.exit(0)
}

main().catch((err) => {
  printWarning(`review-bot failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
