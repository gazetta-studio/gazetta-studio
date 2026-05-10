/**
 * discovery-prep-bot — researches a confident-enhancement issue once.
 *
 * Triggered ONLY by workflow_dispatch (no cron). Two callers:
 *
 *   1. triage-bot (chained, automatic): when triage-bot classifies an issue
 *      as a confident `enhancement` AND no prior discovery doc exists, it
 *      dispatches this bot for that one issue.
 *   2. Maintainer (manual): `gh workflow run discovery-prep-bot.yml -f issue=N`
 *      to re-research a single issue (e.g., after prompt iteration).
 *
 * Per-issue, the bot:
 *   1. Reads the issue body + comments
 *   2. Researches: competitor implementations (web fetch + fact-check),
 *      related project ADRs/design-docs/audits, actor-scenario mapping
 *      (per docs/actor-scenarios.md), foundational-dimensions checklist,
 *      open questions for grilling
 *   3. Writes the findings to `docs/audits/issue-NNN-discovery.md`
 *   4. Opens a draft PR with the new file
 *   5. Comments on the issue with the PR link
 *
 * The bot does NOT write a design doc. Per `feature-design-process.md`,
 * design docs are the OUTPUT of grilling — bot can't substitute. Discovery
 * compresses Phase 1 of feature work; the maintainer grills + decides + writes
 * the design doc themselves.
 *
 * Run locally:
 *   ISSUE_NUMBER=192 GITHUB_REPOSITORY=gazetta-studio/gazetta-studio \
 *     GH_TOKEN=$(gh auth token) npm run discovery-prep-bot -w @gazetta/bots
 * Run in CI:
 *   .github/workflows/discovery-prep-bot.yml (workflow_dispatch only)
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runClaude } from '../_lib/claude.js'
import { octokitFromEnv, repoFromEnv } from '../_lib/github.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = resolve(HERE, 'prompt.md')
const REPO_ROOT = resolve(HERE, '../..')

const DRY_RUN = process.env.DRY_RUN === '1'
const TRANSCRIPTS_DIR = resolve(HERE, '../transcripts')
const RUN_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')

async function main(): Promise<void> {
  const repo = repoFromEnv()
  const octokit = octokitFromEnv()

  const issueNumberStr = process.env.ISSUE_NUMBER
  if (!issueNumberStr || !/^\d+$/.test(issueNumberStr)) {
    console.error('ISSUE_NUMBER env var is required and must be a positive integer')
    console.error(
      'Usage: ISSUE_NUMBER=192 GITHUB_REPOSITORY=owner/repo GH_TOKEN=... npm run discovery-prep-bot -w @gazetta/bots',
    )
    process.exit(2)
  }
  const issueNumber = Number(issueNumberStr)

  console.log(`Discovery prep bot: researching issue #${issueNumber} in ${repo.owner}/${repo.repo}`)

  // Idempotency: skip if the discovery doc already exists on main.
  // The chained dispatch from triage-bot does this check too, but a manual
  // invocation might not — defensive check here.
  const discoveryDocPath = resolve(REPO_ROOT, `docs/audits/issue-${issueNumber}-discovery.md`)
  if (existsSync(discoveryDocPath)) {
    console.log(`Discovery doc already exists at ${discoveryDocPath}; nothing to do.`)
    console.log('To re-research, delete the file and re-run.')
    return
  }

  // Verify the issue exists, is open, and is classified as enhancement.
  // Reading via Octokit so we don't waste a Claude tool call on a basic
  // existence check.
  const { data: issue } = await octokit.issues.get({ ...repo, issue_number: issueNumber })
  if (issue.pull_request) {
    console.error(`#${issueNumber} is a pull request, not an issue. Aborting.`)
    process.exit(1)
  }
  if (issue.state !== 'open') {
    console.log(`#${issueNumber} is ${issue.state}; nothing to research.`)
    return
  }
  const labels = issue.labels.map(l => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean)
  if (!labels.includes('enhancement')) {
    console.log(`#${issueNumber} is not labeled 'enhancement' (current: [${labels.join(', ')}]); nothing to research.`)
    return
  }

  console.log(`#${issueNumber}: "${issue.title}" — labels [${labels.join(', ')}]`)

  if (DRY_RUN) {
    console.log(`DRY_RUN=1 — exiting before invoking Claude.`)
    return
  }

  const promptTemplate = readFileSync(PROMPT_PATH, 'utf-8')
  mkdirSync(TRANSCRIPTS_DIR, { recursive: true })
  const transcriptPath = resolve(TRANSCRIPTS_DIR, `${RUN_TIMESTAMP}-discovery-issue-${issueNumber}.jsonl`)
  console.log(`(transcript: ${transcriptPath})`)

  const prompt = `${promptTemplate}

ISSUE_NUMBER=${issueNumber}
ISSUE_TITLE=${issue.title}
DISCOVERY_DOC_PATH=${discoveryDocPath}
RUN_ID=${process.env.GITHUB_RUN_ID ?? 'local'}`

  // Discovery needs broad tool access: gh CLI for issue/PR ops, file
  // writes for the audit doc, web fetch for competitor research, repo
  // grep + read for project context. NOT Bash for arbitrary commands —
  // we explicitly include Bash because gh CLI requires it, but we expect
  // the bot's surface to stay narrow within Bash (see prompt rules).
  try {
    const result = await runClaude({
      prompt,
      transcriptPath,
      allowedTools: ['Bash', 'Read', 'Grep', 'Glob', 'Write', 'WebFetch', 'WebSearch'],
    })
    if (!result.success) {
      console.log(`Warning: discovery for #${issueNumber} exited ${result.exitCode}`)
      process.exit(result.exitCode)
    }
  } catch (err) {
    console.error(`Discovery for #${issueNumber} threw:`, err)
    process.exit(1)
  }

  console.log(`\nDiscovery prep bot complete. Transcript: ${transcriptPath}`)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
