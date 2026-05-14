/**
 * fix-bot's memory-compaction pass.
 *
 * Runs monthly alongside dead-code-watcher's compactor (per
 * `.github/workflows/bots-compact.yml`). Reads the per-issue
 * skip-list and rewrites `bots/fix-bot/lessons-learned.md`
 * holistically — pruning lessons that no longer apply, adding new
 * ones that recur across rejections.
 *
 * Different shape from dead-code-watcher's compactor: fix-bot's
 * skip-list rarely benefits from glob-rule compaction (most
 * rejections are per-issue, not per-issue-shape). The valuable
 * compaction here is **cross-issue pattern surfacing into prose**
 * that becomes part of Agent A's prompt context.
 *
 * Holistic rewrite (not append): Claude is asked to rewrite the
 * lessons file from scratch each month, given the full
 * skip-list. This prevents lessons from a now-fixed bug class
 * staying around forever and misleading future Agent A runs.
 * Git history preserves the dropped lessons; they're not lost,
 * just no longer in active context.
 *
 * Run locally:
 *   GITHUB_REPOSITORY=gazetta-studio/gazetta-studio \
 *     GH_TOKEN=$(gh auth token) npm run fix-bot:compact -w @gazetta/bots
 * Run in CI:
 *   .github/workflows/bots-compact.yml (1st Sat of each month, 03:00 UTC)
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runClaude } from '../_lib/claude.js'
import { printBanner, printNotice, printRunSummary, printTranscriptPath, printWarning } from '../_lib/ui.js'
import { readSkipList, SKIP_LIST_PATH } from './skip-list.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = resolve(HERE, 'prompts/compact.md')
const REPO_ROOT = resolve(HERE, '../..')
const SKIP_LIST_ABS = resolve(REPO_ROOT, SKIP_LIST_PATH)
const LESSONS_PATH = 'bots/fix-bot/lessons-learned.md'
const LESSONS_ABS = resolve(REPO_ROOT, LESSONS_PATH)
const TRANSCRIPTS_DIR = resolve(HERE, '../transcripts')
const RUN_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')

const DRY_RUN = process.env.DRY_RUN === '1'

/**
 * Minimum entries required to consider running the compactor. Below
 * this we exit early without invoking Claude — there's not enough
 * signal to surface patterns from.
 */
const MIN_ENTRIES_FOR_COMPACTION = Number(process.env.MIN_ENTRIES_FOR_COMPACTION ?? '3')

async function main(): Promise<void> {
  printBanner({
    name: 'fix-bot:compact',
    tagline: 'monthly memory compactor',
    purpose: "Rewrite lessons-learned.md from skip-list patterns; keep the bot's cross-issue memory fresh.",
    inputs: [
      'bots/fix-bot/skip-list.json (per-issue rejections)',
      'bots/fix-bot/lessons-learned.md (previous lessons)',
    ],
    outputs: ['PR rewriting lessons-learned.md with current recurring patterns'],
  })

  const skipList = readSkipList(SKIP_LIST_ABS)
  const entryCount = skipList.entries.length
  const ruleCount = skipList.rules.length
  const lessonsExists = existsSync(LESSONS_ABS)
  const lessonsContent = lessonsExists ? readFileSync(LESSONS_ABS, 'utf-8') : ''

  printNotice(`Current skip-list: ${entryCount} entries + ${ruleCount} rules`)
  printNotice(`Current lessons file: ${lessonsExists ? `${lessonsContent.length} bytes` : 'absent'}`)

  if (entryCount < MIN_ENTRIES_FOR_COMPACTION) {
    printNotice(
      `Below MIN_ENTRIES_FOR_COMPACTION=${MIN_ENTRIES_FOR_COMPACTION} — not enough signal to surface patterns. ✨`,
    )
    return
  }

  if (DRY_RUN) {
    printNotice('DRY_RUN=1 — exiting before invoking Claude.')
    return
  }

  mkdirSync(TRANSCRIPTS_DIR, { recursive: true })
  const promptTemplate = readFileSync(PROMPT_PATH, 'utf-8')
  const transcriptPath = resolve(TRANSCRIPTS_DIR, `${RUN_TIMESTAMP}-fix-bot-compact.jsonl`)
  printTranscriptPath(transcriptPath)

  const runStart = Date.now()
  const prompt = `${promptTemplate}

SKIP_LIST_PATH=${SKIP_LIST_PATH}
LESSONS_PATH=${LESSONS_PATH}
SKIP_LIST_JSON=${JSON.stringify(skipList, null, 2)}
PREVIOUS_LESSONS=
${lessonsContent}
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
