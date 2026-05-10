/**
 * discovery-prep-bot — researches confident-enhancement issues.
 *
 * Two trigger modes:
 *
 *   1. Cron (default): scans for issues matching the input contract
 *      (label `enhancement`, lacks any of `ready-for-human`,
 *      `ready-for-agent`, `wontfix`, `needs-info`). Processes oldest-first
 *      with a per-run budget. Backlog converges over multiple daily runs.
 *
 *   2. workflow_dispatch with `issue` input: researches one specific
 *      issue, regardless of label state. Useful for re-research after
 *      prompt iteration.
 *
 * Per-issue, the bot:
 *   1. Reads the issue body + comments
 *   2. Researches: competitor implementations (web fetch + fact-check),
 *      related project ADRs/design-docs/audits, actor-scenario mapping
 *      (per docs/actor-scenarios.md), foundational-dimensions checklist,
 *      open questions for grilling
 *   3. Posts findings as a single issue comment
 *   4. Adds `ready-for-human` label (signals: research done, design
 *      grilling can start)
 *
 * Output is an ISSUE COMMENT plus the `ready-for-human` label. No PR,
 * no repo file. The label is the bot's idempotency contract — once
 * applied, future cron runs skip the issue (since the label is in the
 * exclude-set of the input query).
 *
 * The `ready-for-human` label is shared with fix-bot's "stuck — needs
 * human" state. Maintainer disambiguates by reading the comment thread:
 * a discovery-prep-bot outcome tag means "research done"; a fix-bot
 * outcome tag means "fix-bot stuck."
 *
 * The bot does NOT write a design doc. Per `feature-design-process.md`,
 * design docs are the OUTPUT of grilling — bot can't substitute. Discovery
 * compresses Phase 1 of feature work; the maintainer grills + decides + writes
 * the design doc themselves.
 *
 * Run locally:
 *   # Cron mode — scan all open enhancements:
 *   GITHUB_REPOSITORY=gazetta-studio/gazetta-studio \
 *     GH_TOKEN=$(gh auth token) npm run discovery-prep-bot -w @gazetta/bots
 *   # Manual one-issue mode:
 *   ISSUE_NUMBER=192 GITHUB_REPOSITORY=gazetta-studio/gazetta-studio \
 *     GH_TOKEN=$(gh auth token) npm run discovery-prep-bot -w @gazetta/bots
 * Run in CI:
 *   .github/workflows/discovery-prep-bot.yml (cron + workflow_dispatch)
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runClaude } from '../_lib/claude.js'
import {
  findIssuesByLabels,
  findLastSuccessfulRunIso,
  hasPriorCommentFromBot,
  octokitFromEnv,
  repoFromEnv,
} from '../_lib/github.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = resolve(HERE, 'prompt.md')

const DRY_RUN = process.env.DRY_RUN === '1'
const TRANSCRIPTS_DIR = resolve(HERE, '../transcripts')
const RUN_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')

// Per-run budget. Discovery is expensive (~5-10 min per issue: web search,
// fact-check, multi-doc grep). Workflow timeout is 60 min; exit gracefully
// at 50 min for the upload-artifacts step + any in-flight per-issue work.
// Override via env for local manual runs.
const PER_RUN_BUDGET_MS = Number(process.env.BUDGET_MS ?? 50 * 60 * 1000)

// Optional manual override: set LOOKBACK_HOURS to force a wider scan than
// the auto-detected since-anchor. Same shape as triage-bot's override.
const rawLookback = process.env.LOOKBACK_HOURS
const LOOKBACK_HOURS_OVERRIDE = rawLookback !== undefined && rawLookback !== '' ? rawLookback : undefined

async function main(): Promise<void> {
  const repo = repoFromEnv()
  const octokit = octokitFromEnv()

  // Manual one-issue mode short-circuits the cron scan.
  const issueNumberStr = process.env.ISSUE_NUMBER
  if (issueNumberStr) {
    if (!/^\d+$/.test(issueNumberStr)) {
      console.error(`ISSUE_NUMBER='${issueNumberStr}' must be a positive integer`)
      process.exit(2)
    }
    await researchOneIssue(octokit, repo, Number(issueNumberStr))
    return
  }

  // Cron mode: scan candidates and process per-run-budget.
  const sinceIso = await resolveSinceIso(octokit, repo)
  console.log(`Discovery prep bot: scanning ${repo.owner}/${repo.repo} for confident-enhancement candidates`)

  const allCandidates = await findIssuesByLabels(octokit, repo, {
    requireAll: ['enhancement'],
    excludeAny: ['ready-for-human', 'ready-for-agent', 'wontfix', 'needs-info'],
    sinceIso,
  })

  if (allCandidates.length === 0) {
    console.log('No discovery-prep candidates found. Inbox zero — nothing to do.')
    return
  }

  // Oldest-first so longest-waiting enhancements get research first.
  const candidates = [...allCandidates].sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  console.log(`Discovery candidates (${candidates.length}, oldest-first):`)
  for (const c of candidates) {
    console.log(`  #${c.number} "${c.title}"`)
  }

  if (DRY_RUN) {
    console.log(`DRY_RUN=1 — exiting before invoking Claude (${candidates.length} would be processed).`)
    return
  }

  const runStart = Date.now()
  let processed = 0
  for (const candidate of candidates) {
    const elapsed = Date.now() - runStart
    if (elapsed > PER_RUN_BUDGET_MS) {
      const remaining = candidates.length - processed
      console.log(
        `\nPer-run budget exhausted (${Math.round(elapsed / 1000)}s elapsed > ${Math.round(PER_RUN_BUDGET_MS / 1000)}s budget).`,
      )
      console.log(`Stopping with ${remaining} candidate(s); tomorrow's run picks them up (oldest-first sort holds).`)
      for (const skipped of candidates.slice(processed)) {
        console.log(`  #${skipped.number} "${skipped.title}"`)
      }
      break
    }

    console.log(
      `\n=== Researching #${candidate.number}: "${candidate.title}" (${processed + 1}/${candidates.length}, ${Math.round(elapsed / 1000)}s elapsed) ===`,
    )
    try {
      await researchOneIssue(octokit, repo, candidate.number)
    } catch (err) {
      console.log(`Warning: research of #${candidate.number} threw: ${err}; continuing.`)
    }
    processed++
  }

  console.log(`\nDiscovery prep bot complete. Processed ${processed}/${candidates.length}.`)
}

/**
 * Resolve the "since" anchor for incremental scanning.
 *
 *   - LOOKBACK_HOURS=0           → no since filter (full backlog scan)
 *   - LOOKBACK_HOURS=N (N > 0)   → since = now - N hours
 *   - unset (cron default)       → since = last successful discovery-prep-bot
 *                                  run minus 1h overlap
 */
async function resolveSinceIso(
  octokit: ReturnType<typeof octokitFromEnv>,
  repo: ReturnType<typeof repoFromEnv>,
): Promise<string | undefined> {
  if (LOOKBACK_HOURS_OVERRIDE !== undefined) {
    const hours = Number(LOOKBACK_HOURS_OVERRIDE)
    if (hours === 0) {
      console.log('LOOKBACK_HOURS=0 — full backlog scan (no since filter)')
      return undefined
    }
    const sinceIso = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()
    console.log(`LOOKBACK_HOURS=${hours} — scanning issues updated since ${sinceIso}`)
    return sinceIso
  }
  const currentRunId = process.env.GITHUB_RUN_ID ? Number(process.env.GITHUB_RUN_ID) : undefined
  const lastRun = await findLastSuccessfulRunIso(octokit, repo, 'discovery-prep-bot.yml', currentRunId)
  if (!lastRun) {
    console.log('No prior successful run — full backlog scan (first ever invocation)')
    return undefined
  }
  const lastRunMs = new Date(lastRun).getTime()
  const sinceIso = new Date(lastRunMs - 60 * 60 * 1000).toISOString()
  console.log(`Auto-detected last successful run completed at ${lastRun}; scanning since ${sinceIso} (1h overlap)`)
  return sinceIso
}

/**
 * Research one issue. Used by both cron mode (per-candidate loop) and
 * manual mode (single ISSUE_NUMBER input).
 *
 * Validates the issue is open + enhancement + not already commented on
 * by discovery-prep-bot. The label-driven cron candidate query already
 * applies these filters — but a manual `gh workflow run -f issue=N` can
 * target any issue, so the per-issue checks are defense-in-depth.
 */
async function researchOneIssue(
  octokit: ReturnType<typeof octokitFromEnv>,
  repo: ReturnType<typeof repoFromEnv>,
  issueNumber: number,
): Promise<void> {
  const { data: issue } = await octokit.issues.get({ ...repo, issue_number: issueNumber })
  if (issue.pull_request) {
    console.log(`#${issueNumber} is a pull request, not an issue. Skipping.`)
    return
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

  // Idempotency: skip if discovery-prep-bot has already commented. The
  // label-driven input check would catch this for cron-mode candidates
  // (because we'd have applied `ready-for-human` after the prior comment),
  // but a manual one-issue invocation can target any issue.
  const alreadyCommented = await hasPriorCommentFromBot(octokit, repo, issueNumber, 'discovery-prep-bot')
  if (alreadyCommented) {
    console.log(`#${issueNumber}: discovery-prep-bot has already commented; nothing to do.`)
    console.log('To re-research, manually delete the prior comment AND remove `ready-for-human`, then re-run.')
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

  const result = await runClaude({
    prompt,
    transcriptPath,
    allowedTools: ['Bash', 'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
  })
  if (!result.success) {
    console.log(`Warning: discovery for #${issueNumber} exited ${result.exitCode}`)
  }
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
