/**
 * dead-code-watcher's memory-compaction pass.
 *
 * Runs monthly on the 1st Saturday at 03:00 UTC (per
 * .github/workflows/dead-code-watcher-compact.yml). Reads the
 * skip-list and asks Claude to identify groups of ≥3 entries that
 * share a pattern (path-prefix + reason, or glob-collapsible shape),
 * propose generalized rules, and open a PR with the new skip-list
 * shape.
 *
 * "Compaction" not "compression": the result is the skip-list
 * literally getting smaller AND more powerful — fewer concrete
 * entries, more general rules that catch future findings too. Same
 * shape as how LLM session memory compacts: summarize accumulated
 * state into a smaller form that preserves load-bearing information.
 *
 * Conservatism: rules only get proposed when 3+ entries share a
 * clear pattern. The compact-bot is allowed to be wrong (the PR is
 * reviewable), but it's expensive to maintainer-time to review
 * spurious compactions, so the prompt asks for high-confidence
 * generalizations only.
 *
 * Run locally:
 *   GITHUB_REPOSITORY=gazetta-studio/gazetta-studio \
 *     GH_TOKEN=$(gh auth token) npm run dead-code-watcher:compact -w @gazetta/bots
 * Run in CI:
 *   .github/workflows/dead-code-watcher-compact.yml (1st Sat 03:00 UTC)
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runClaude } from '../_lib/claude.js'
import { readSkipList, SKIP_LIST_PATH } from '../_lib/skip-list.js'
import { printBanner, printNotice, printRunSummary, printTranscriptPath, printWarning } from '../_lib/ui.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = resolve(HERE, 'prompts/compact.md')
const REPO_ROOT = resolve(HERE, '../..')
const SKIP_LIST_ABS = resolve(REPO_ROOT, SKIP_LIST_PATH)
const TRANSCRIPTS_DIR = resolve(HERE, '../transcripts')
const RUN_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')

const DRY_RUN = process.env.DRY_RUN === '1'

/**
 * Minimum entries required to consider compaction. Below this we
 * exit early without invoking Claude — there's nothing to generalize.
 */
const MIN_ENTRIES_FOR_COMPACTION = 3

async function main(): Promise<void> {
  printBanner({
    name: 'dead-code-watcher:compact',
    tagline: 'monthly memory compactor',
    purpose: "Generalize skip-list entries into rules; keep the bot's memory compact and powerful.",
    inputs: ['bots/dead-code-watcher/skip-list.json'],
    outputs: ['PR replacing N specific entries with M general rules (compactedFrom: N)'],
  })

  const skipList = readSkipList(SKIP_LIST_ABS)
  const entryCount = skipList.entries.length
  const ruleCount = skipList.rules.length

  printNotice(`Current skip-list: ${entryCount} entries + ${ruleCount} rules`)

  if (entryCount < MIN_ENTRIES_FOR_COMPACTION) {
    printNotice(`Below MIN_ENTRIES_FOR_COMPACTION=${MIN_ENTRIES_FOR_COMPACTION} — nothing to compact. ✨`)
    return
  }

  if (DRY_RUN) {
    printNotice('DRY_RUN=1 — exiting before invoking Claude.')
    return
  }

  // Hand the entire skip-list to Claude. It's small (under 100 entries
  // typically), no context pressure. Claude reads, proposes rules,
  // commits + opens PR.
  mkdirSync(TRANSCRIPTS_DIR, { recursive: true })
  const promptTemplate = readFileSync(PROMPT_PATH, 'utf-8')
  const transcriptPath = resolve(TRANSCRIPTS_DIR, `${RUN_TIMESTAMP}-dead-code-compact.jsonl`)
  printTranscriptPath(transcriptPath)

  const runStart = Date.now()
  const prompt = `${promptTemplate}

SKIP_LIST_PATH=${SKIP_LIST_PATH}
SKIP_LIST_JSON=${JSON.stringify(skipList, null, 2)}
RUN_ID=${process.env.GITHUB_RUN_ID ?? 'local'}`

  try {
    const result = await runClaude({
      prompt,
      transcriptPath,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit'],
    })
    if (!result.success) {
      printWarning(`Claude exited ${result.exitCode}; transcript at ${transcriptPath}`)
    }
  } catch (err) {
    printWarning(`compact threw: ${err}; transcript at ${transcriptPath}`)
  }

  const totalSec = Math.round((Date.now() - runStart) / 1000)
  printRunSummary({
    verb: 'Compacted',
    processed: 1,
    total: 1,
    skipped: 0,
    notes: [`Transcript: ${transcriptPath}`],
    elapsedSec: totalSec,
  })
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
