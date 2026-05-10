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

async function main(): Promise<void> {
  const repo = repoFromEnv()
  const octokit = octokitFromEnv()

  console.log(`Triage bot: scanning ${repo.owner}/${repo.repo} for triage candidates`)

  const candidates = await findTriageCandidates(octokit, repo)

  if (candidates.length === 0) {
    console.log('No triage candidates found. Inbox zero — nothing to do.')
    return
  }

  console.log(`Triage candidates (${candidates.length}):`)
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

  for (const candidate of candidates) {
    console.log(`\n=== Triaging #${candidate.number}: "${candidate.title}" ===`)
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
  }

  console.log(`\nTriage bot complete. Transcripts: ${TRANSCRIPTS_DIR}`)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
