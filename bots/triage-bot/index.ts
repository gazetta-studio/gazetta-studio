/**
 * triage-bot — daily autonomous enrichment of incoming issues.
 *
 * Scope: every open issue that's either labeled `needs-triage` OR completely
 * unlabeled. Per-issue, the bot reads the body + comments + linked code,
 * categorizes (bug / enhancement), applies area + needs-triage labels, runs
 * the reproducer for bugs when possible, posts findings, and (for high-
 * confidence reproduced bugs) drafts an agent brief comment.
 *
 * The bot NEVER advances issue state past `needs-triage` (no `ready-for-agent`,
 * no `wontfix`, no closing). Those decisions stay with maintainers via the
 * interactive `/triage` skill, which sees the bot's enrichment as starting
 * research, not as a verdict.
 *
 * Conventions shared with the `/triage` skill (see `bots/_lib/triage.ts`):
 *   - AI disclaimer prefix on every comment
 *   - Two category roles: bug | enhancement
 *   - Outcome-tag suffix per flake-watcher convention
 *
 * Run locally:
 *   DRY_RUN=1 GITHUB_REPOSITORY=gazetta-studio/gazetta-studio \
 *     GH_TOKEN=$(gh auth token) npm run triage-bot -w @gazetta/bots
 * Run in CI:
 *   .github/workflows/triage-bot.yml (daily 11:00 UTC)
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runClaude } from '../_lib/claude.js'
import { findTriageCandidates, octokitFromEnv, repoFromEnv } from '../_lib/github.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = resolve(HERE, 'prompt.md')

const DRY_RUN = process.env.DRY_RUN === '1'
const TRANSCRIPTS_DIR = resolve(HERE, '../transcripts')
const RUN_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')

// Per-run budget. Workflow timeout is 60 min; we exit gracefully at 50 min
// to leave 10 min margin for the upload-artifacts step + any in-flight
// per-issue work. Issues we don't reach this run will be picked up by the
// next daily run (sorted oldest-first so the backlog converges in a few
// days for one-time spikes). Override via env for local manual runs.
const PER_RUN_BUDGET_MS = Number(process.env.BUDGET_MS ?? 50 * 60 * 1000)

async function main(): Promise<void> {
  const repo = repoFromEnv()
  const octokit = octokitFromEnv()

  console.log(`Triage bot: scanning ${repo.owner}/${repo.repo} for triage candidates`)

  const allCandidates = await findTriageCandidates(octokit, repo)

  if (allCandidates.length === 0) {
    console.log('No triage candidates found. Inbox zero — nothing to do.')
    return
  }

  // Sort oldest-first so longest-untriaged issues get attention first.
  // Combined with the per-run budget below, this guarantees a one-time
  // backlog spike converges in a few daily runs rather than starving
  // newer issues forever (which a newest-first or arrival-order sort would).
  const candidates = [...allCandidates].sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  console.log(`Triage candidates (${candidates.length}, oldest-first):`)
  for (const c of candidates) {
    const labels = c.labels.length ? `[${c.labels.join(', ')}]` : '[unlabeled]'
    console.log(`  #${c.number} ${labels} "${c.title}"`)
  }

  if (DRY_RUN) {
    console.log(`DRY_RUN=1 — exiting before invoking Claude (${candidates.length} would be processed).`)
    return
  }

  const promptTemplate = readFileSync(PROMPT_PATH, 'utf-8')
  mkdirSync(TRANSCRIPTS_DIR, { recursive: true })

  const runStart = Date.now()
  let processed = 0

  for (const candidate of candidates) {
    const elapsed = Date.now() - runStart
    if (elapsed > PER_RUN_BUDGET_MS) {
      const remaining = candidates.length - processed
      console.log(
        `\nPer-run budget exhausted (${Math.round(elapsed / 1000)}s elapsed > ${Math.round(PER_RUN_BUDGET_MS / 1000)}s budget).`,
      )
      console.log(`Stopping with ${remaining} candidate(s) un-triaged this run; tomorrow's run picks them up.`)
      console.log('Skipped (oldest first will be retried tomorrow):')
      for (const skipped of candidates.slice(processed)) {
        console.log(`  #${skipped.number} "${skipped.title}"`)
      }
      break
    }

    console.log(
      `\n=== Triaging #${candidate.number}: "${candidate.title}" (${processed + 1}/${candidates.length}, ${Math.round(elapsed / 1000)}s elapsed) ===`,
    )
    const prompt = `${promptTemplate}

ISSUE_NUMBER=${candidate.number}
ISSUE_TITLE=${candidate.title}
RUN_ID=${process.env.GITHUB_RUN_ID ?? 'local'}`

    const transcriptPath = resolve(TRANSCRIPTS_DIR, `${RUN_TIMESTAMP}-issue-${candidate.number}.jsonl`)
    console.log(`(transcript: ${transcriptPath})`)

    try {
      // Triage needs more tools than flake-watcher: Bash for gh + npm test +
      // file inspection; Read for reading repo files Claude wants to inspect
      // outside of bash output.
      const result = await runClaude({
        prompt,
        transcriptPath,
        allowedTools: ['Bash', 'Read', 'Grep', 'Glob'],
      })
      if (!result.success) {
        console.log(`Warning: triage of #${candidate.number} exited ${result.exitCode}; continuing.`)
      }
    } catch (err) {
      console.log(`Warning: triage of #${candidate.number} threw: ${err}; continuing.`)
    }
    processed++
  }

  console.log(`\nTriage bot complete. Processed ${processed}/${candidates.length}. Transcripts: ${TRANSCRIPTS_DIR}`)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
