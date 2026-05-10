/**
 * fix-bot — attempts to fix `bug + ready-for-agent` issues.
 *
 * Two trigger modes:
 *
 *   1. Cron (default): scans for `bug + ready-for-agent` issues that
 *      lack `ready-for-human` / `wontfix` / `needs-info` AND haven't
 *      been touched by fix-bot yet (no prior fix-bot comment).
 *   2. workflow_dispatch with `issue` input: attempt a single specific
 *      issue, regardless of label state. Useful for re-attempts after
 *      prompt iteration.
 *
 * Per-issue, the bot:
 *   1. Reads the issue body + comments + linked code
 *   2. Tries to write a FAILING TEST that captures the bug
 *      a. If can't write a failing test → post stuck-comment +
 *         apply `ready-for-human` + exit
 *      b. If failing test runs and reproduces the bug → continue
 *   3. Commits the failing test as commit 1 (CI will show this red)
 *   4. Implements the fix
 *   5. Commits the fix as commit 2 (CI will show this green)
 *   6. Pushes branch `fix/issue-NNN` (force if exists)
 *   7. Opens or updates PR with title `fix: <issue title> (#NNN)`
 *   8. Comments on the issue with the PR link
 *
 * The TDD-first commit ordering is the load-bearing safety contract per
 * `team-preferences.md` rule 31. Without a failing test first, fix-bot's
 * "fix" has no contract — it could compile and pass existing tests but
 * not actually address the reported bug. The failing-test commit IS the
 * specification.
 *
 * Maintainer is the irreducible merge gate. fix-bot opens PRs but never
 * merges — that's per project rule 33 (no direct main commits) and per
 * `team-preferences.md` rule 16 (rebase posture, gh pr merge).
 *
 * Run locally:
 *   # Cron mode — scan all bug + ready-for-agent issues:
 *   GITHUB_REPOSITORY=gazetta-studio/gazetta-studio \
 *     GH_TOKEN=$(gh auth token) npm run fix-bot -w @gazetta/bots
 *   # Manual one-issue mode:
 *   ISSUE_NUMBER=290 GITHUB_REPOSITORY=gazetta-studio/gazetta-studio \
 *     GH_TOKEN=$(gh auth token) npm run fix-bot -w @gazetta/bots
 * Run in CI:
 *   .github/workflows/fix-bot.yml (cron + workflow_dispatch)
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runClaude } from '../_lib/claude.js'
import { findIssuesByLabels, hasPriorCommentFromBot, octokitFromEnv, repoFromEnv } from '../_lib/github.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = resolve(HERE, 'prompt.md')

const DRY_RUN = process.env.DRY_RUN === '1'
const TRANSCRIPTS_DIR = resolve(HERE, '../transcripts')
const RUN_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')

// Per-run budget. Fix attempts are expensive — full npm ci + build +
// running the failing test + writing the fix + verifying CI green can
// take 15-30 min per issue. Budget at 50 min (10 min margin from
// workflow's 60 min timeout) means roughly 1-2 fixes per cron.
const PER_RUN_BUDGET_MS = Number(process.env.BUDGET_MS ?? 50 * 60 * 1000)

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
    await fixOneIssue(octokit, repo, Number(issueNumberStr))
    return
  }

  console.log(`Fix bot: scanning ${repo.owner}/${repo.repo} for bug+ready-for-agent candidates`)

  // Label-driven input: every bug ready-for-agent that hasn't escalated
  // to a maintainer-only state. The `ready-for-agent` label is the
  // upstream signal (applied by triage-bot or by maintainer); fix-bot's
  // own completion is "ready-for-human" (when stuck) or PR existence
  // (when fix attempted). The hasPriorCommentFromBot check below catches
  // the PR-attempted path; ready-for-human catches the stuck path.
  const allCandidates = await findIssuesByLabels(octokit, repo, {
    requireAll: ['bug', 'ready-for-agent'],
    excludeAny: ['ready-for-human', 'wontfix', 'needs-info'],
  })

  if (allCandidates.length === 0) {
    console.log('No fix-bot candidates found. Inbox zero — nothing to do.')
    return
  }

  const candidates = [...allCandidates].sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  console.log(`Fix candidates (${candidates.length}, oldest-first):`)
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
      console.log(`Stopping with ${remaining} candidate(s); tomorrow's run picks them up.`)
      for (const skipped of candidates.slice(processed)) {
        console.log(`  #${skipped.number} "${skipped.title}"`)
      }
      break
    }

    console.log(
      `\n=== Fixing #${candidate.number}: "${candidate.title}" (${processed + 1}/${candidates.length}, ${Math.round(elapsed / 1000)}s elapsed) ===`,
    )
    try {
      await fixOneIssue(octokit, repo, candidate.number)
    } catch (err) {
      console.log(`Warning: fix attempt for #${candidate.number} threw: ${err}; continuing.`)
    }
    processed++
  }

  console.log(`\nFix bot complete. Processed ${processed}/${candidates.length}.`)
}

/**
 * Attempt to fix one issue. Used by cron mode (per-candidate loop) and
 * manual one-issue mode.
 *
 * Validates the issue is open + bug + ready-for-agent + not already
 * fix-bot-touched. Cron candidate query already applies these filters,
 * but a manual ISSUE_NUMBER invocation can target any issue, so the
 * checks are defense-in-depth.
 */
async function fixOneIssue(
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
    console.log(`#${issueNumber} is ${issue.state}; nothing to fix.`)
    return
  }
  const labels = issue.labels.map(l => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean)
  if (!labels.includes('bug') || !labels.includes('ready-for-agent')) {
    console.log(`#${issueNumber} lacks 'bug' + 'ready-for-agent' (current: [${labels.join(', ')}]); skipping.`)
    return
  }
  if (labels.includes('ready-for-human') || labels.includes('wontfix') || labels.includes('needs-info')) {
    console.log(`#${issueNumber} has terminal-state label; skipping.`)
    return
  }

  // Idempotency: skip if fix-bot has already commented. The cron query
  // doesn't filter on this directly (no label for "fix-bot tried"); the
  // bot's outcome tag in any prior comment IS the signal.
  const alreadyTried = await hasPriorCommentFromBot(octokit, repo, issueNumber, 'fix-bot')
  if (alreadyTried) {
    console.log(`#${issueNumber}: fix-bot has already attempted; nothing to do.`)
    console.log('To re-attempt, manually delete the prior fix-bot comment, then re-run.')
    return
  }

  console.log(`#${issueNumber}: "${issue.title}" — labels [${labels.join(', ')}]`)

  if (DRY_RUN) {
    console.log(`DRY_RUN=1 — exiting before invoking Claude.`)
    return
  }

  const promptTemplate = readFileSync(PROMPT_PATH, 'utf-8')
  mkdirSync(TRANSCRIPTS_DIR, { recursive: true })
  const transcriptPath = resolve(TRANSCRIPTS_DIR, `${RUN_TIMESTAMP}-fix-issue-${issueNumber}.jsonl`)
  console.log(`(transcript: ${transcriptPath})`)

  const branchName = `fix/issue-${issueNumber}`
  const prompt = `${promptTemplate}

ISSUE_NUMBER=${issueNumber}
ISSUE_TITLE=${issue.title}
BRANCH_NAME=${branchName}
RUN_ID=${process.env.GITHUB_RUN_ID ?? 'local'}`

  // Fix-bot needs the widest tool set: gh CLI for issue/PR ops, file
  // writes for the test + fix code, repo grep + read for context, Bash
  // for npm test / vitest / git operations.
  const result = await runClaude({
    prompt,
    transcriptPath,
    allowedTools: ['Bash', 'Read', 'Grep', 'Glob', 'Write', 'Edit'],
  })
  if (!result.success) {
    console.log(`Warning: fix attempt for #${issueNumber} exited ${result.exitCode}`)
  }
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
