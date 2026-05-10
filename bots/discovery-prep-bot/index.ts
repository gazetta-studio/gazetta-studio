/**
 * discovery-prep-bot — researches a confident-enhancement issue once.
 *
 * Triggered ONLY by workflow_dispatch (no cron). Two callers:
 *
 *   1. triage-bot (chained, automatic): when triage-bot classifies an issue
 *      as a confident `enhancement` AND no prior discovery comment exists,
 *      it dispatches this bot for that one issue.
 *   2. Maintainer (manual): `gh workflow run discovery-prep-bot.yml -f issue=N`
 *      to re-research a single issue (e.g., after prompt iteration).
 *
 * Per-issue, the bot:
 *   1. Reads the issue body + comments
 *   2. Researches: competitor implementations (web fetch + fact-check),
 *      related project ADRs/design-docs/audits, actor-scenario mapping
 *      (per docs/actor-scenarios.md), foundational-dimensions checklist,
 *      open questions for grilling
 *   3. Posts the findings as a single issue comment (the research doc body)
 *
 * Output is an ISSUE COMMENT, not a PR or repo file. Reasons:
 *   - Research lives where the conversation lives
 *   - No PR spam if the chain-dispatch fires N times in a backlog scenario
 *   - Idempotency check is just "do I have a prior comment with my outcome
 *     tag here?" — same pattern as flake-watcher / triage-bot
 *   - Maintainer reads the comment when starting grilling; copies the
 *     useful parts into a real design doc (which they would have done from
 *     a draft PR audit doc anyway, so no value lost)
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
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runClaude } from '../_lib/claude.js'
import { hasPriorCommentFromBot, octokitFromEnv, repoFromEnv } from '../_lib/github.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = resolve(HERE, 'prompt.md')

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

  // Verify the issue exists, is open, and is classified as enhancement.
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

  // Idempotency: skip if discovery-prep-bot has already commented on this
  // issue. The chained dispatch from triage-bot does this check too, but
  // a manual invocation might not — defensive check here.
  const alreadyCommented = await hasPriorCommentFromBot(octokit, repo, issueNumber, 'discovery-prep-bot')
  if (alreadyCommented) {
    console.log(`#${issueNumber}: discovery-prep-bot has already commented; nothing to do.`)
    console.log('To re-research, manually delete the prior comment first, then re-run.')
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
RUN_ID=${process.env.GITHUB_RUN_ID ?? 'local'}`

  // Discovery needs broad tool access: gh CLI for issue comment, web
  // fetch for competitor research, repo grep + read for project context.
  // No Write tool — bot doesn't write any files; output goes via gh
  // issue comment.
  try {
    const result = await runClaude({
      prompt,
      transcriptPath,
      allowedTools: ['Bash', 'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
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
