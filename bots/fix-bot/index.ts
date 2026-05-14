/**
 * fix-bot — attempts to fix `bug + ready-for-agent` issues.
 *
 * Two trigger modes:
 *
 *   1. Cron (default): scans for `bug + ready-for-agent` issues that
 *      lack `ready-for-human` / `wontfix` / `needs-info` AND haven't
 *      been touched by fix-bot yet (no `fix-bot-attempted` label OR
 *      reopened after the attempt).
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
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runClaude } from '../_lib/claude.js'
import { branchHasCommits, captureCommitMessages, captureDiff, resetToMain } from '../_lib/git-tree.js'
import {
  addLabel,
  findIssuesByLabels,
  getLabelAppliedAt,
  getReopenedAt,
  octokitFromEnv,
  repoFromEnv,
  type RepoIdentity,
} from '../_lib/github.js'
import { parseReviewerVerdict } from '../_lib/reviewer-verdict.js'
import {
  printBanner,
  printCandidateHeader,
  printCandidateList,
  printNotice,
  printRunSummary,
  printTranscriptPath,
  printWarning,
} from '../_lib/ui.js'
import { diagnoseFailure, formatFailureComment } from './failure-diagnostic.js'
import {
  appendEntry,
  findSkipMatch,
  type IssueFingerprint,
  readSkipList,
  type SkipList,
  SKIP_LIST_PATH,
  writeSkipList,
} from './skip-list.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = resolve(HERE, 'prompts/per-issue.md')
const REVIEWER_PROMPT_PATH = resolve(HERE, 'prompts/reviewer.md')
const REPO_ROOT = resolve(HERE, '../..')
const SKIP_LIST_ABS = resolve(REPO_ROOT, SKIP_LIST_PATH)
const LESSONS_PATH = 'bots/fix-bot/lessons-learned.md'
const LESSONS_ABS = resolve(REPO_ROOT, LESSONS_PATH)

const DRY_RUN = process.env.DRY_RUN === '1'
const TRANSCRIPTS_DIR = resolve(HERE, '../transcripts')
const RUN_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')

// Per-run budget. Fix attempts are expensive — full npm ci + build +
// running the failing test + writing the fix + verifying CI green can
// take 15-30 min per issue. Budget at 50 min (10 min margin from
// workflow's 60 min timeout) means roughly 1-2 fixes per cron.
const PER_RUN_BUDGET_MS = Number(process.env.BUDGET_MS ?? 50 * 60 * 1000)

/**
 * Maximum generator-critic loop iterations per issue. Agent A
 * (cleanup) proposes a fix; Agent B (reviewer) inspects + votes
 * APPROVE / REJECT / NEEDS_HUMAN. On REJECT, the orchestrator resets
 * the working tree and re-runs Agent A with the reviewer's note.
 * After this cap, the orchestrator gives up and records `needs-human`
 * in the skip-list.
 */
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS ?? '5')

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

  printBanner({
    name: 'fix-bot',
    tagline: 'implementer',
    purpose: 'Fix `bug + ready-for-agent` issues with TDD-first commit ordering.',
    inputs: [
      'Open issues with `bug` AND `ready-for-agent`',
      'AND no `ready-for-human` / `wontfix` / `needs-info`',
      'AND no `fix-bot-attempted` label, OR reopened since (idempotency)',
    ],
    outputs: ['EITHER draft PR (commit 1: failing test, commit 2: fix)', 'OR stuck-comment + `ready-for-human` label'],
  })

  printNotice(`Scanning ${repo.owner}/${repo.repo} for bug+ready-for-agent candidates`)

  // Label-driven input: every bug ready-for-agent that hasn't escalated
  // to a maintainer-only state. The `ready-for-agent` label is the
  // upstream signal (applied by triage-bot or by maintainer); fix-bot's
  // own completion is "ready-for-human" (when stuck) or PR existence
  // (when fix attempted). The fix-bot-attempted label below catches
  // the PR-attempted path; ready-for-human catches the stuck path.
  // Auto-clear-on-reopen lets maintainers re-queue an issue without
  // touching the label by simply reopening it.
  const allCandidates = await findIssuesByLabels(octokit, repo, {
    requireAll: ['bug', 'ready-for-agent'],
    excludeAny: ['ready-for-human', 'wontfix', 'needs-info'],
  })

  if (allCandidates.length === 0) {
    printNotice('No fix-bot candidates found. Inbox zero — nothing to do. ✨')
    return
  }

  const candidates = [...allCandidates].sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  printCandidateList({
    noun: 'bug',
    candidates: candidates.map(c => ({ ref: `#${c.number}`, label: c.title })),
  })

  if (DRY_RUN) {
    printNotice(`DRY_RUN=1 — exiting before invoking Claude (${candidates.length} would be processed).`)
    return
  }

  const runStart = Date.now()
  let processed = 0
  for (const candidate of candidates) {
    const elapsed = Date.now() - runStart
    if (elapsed > PER_RUN_BUDGET_MS) {
      const remaining = candidates.length - processed
      printWarning(
        `Per-run budget exhausted (${Math.round(elapsed / 1000)}s > ${Math.round(PER_RUN_BUDGET_MS / 1000)}s). Stopping with ${remaining} unfixed; tomorrow's run picks them up.`,
      )
      for (const skipped of candidates.slice(processed)) {
        console.log(`     ⏭  #${skipped.number} "${skipped.title}"`)
      }
      break
    }

    printCandidateHeader({
      index: processed + 1,
      total: candidates.length,
      label: `#${candidate.number} · ${candidate.title}`,
      elapsedSec: Math.round(elapsed / 1000),
    })

    try {
      await fixOneIssue(octokit, repo, candidate.number)
    } catch (err) {
      printWarning(`fix attempt for #${candidate.number} threw: ${err}; continuing.`)
    }
    processed++
  }

  const totalSec = Math.round((Date.now() - runStart) / 1000)
  printRunSummary({
    verb: 'Fixed',
    processed,
    total: candidates.length,
    skipped: candidates.length - processed,
    elapsedSec: totalSec,
  })
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
    printNotice(`#${issueNumber} is a pull request, not an issue. Skipping.`)
    return
  }
  if (issue.state !== 'open') {
    printNotice(`#${issueNumber} is ${issue.state}; nothing to fix.`)
    return
  }
  const labels = issue.labels.map(l => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean)
  if (!labels.includes('bug') || !labels.includes('ready-for-agent')) {
    printNotice(`#${issueNumber} lacks 'bug' + 'ready-for-agent' (current: [${labels.join(', ')}]); skipping.`)
    return
  }
  if (labels.includes('ready-for-human') || labels.includes('wontfix') || labels.includes('needs-info')) {
    printNotice(`#${issueNumber} has terminal-state label; skipping.`)
    return
  }

  // Idempotency: skip if the `fix-bot-attempted` label is present AND
  // the issue hasn't been reopened since the label was applied.
  //
  // - Label is applied after every attempt (success → PR opened; failure
  //   → stuck-comment + ready-for-human).
  // - Maintainer can clear idempotency two ways:
  //   1. Remove the `fix-bot-attempted` label (explicit retry).
  //   2. Reopen the issue after the bot tried (implicit retry — the
  //      reopen IS the signal that the prior attempt didn't stick).
  //
  // Previous design used a substring marker in comment bodies. Replaced
  // because (a) maintainers couldn't unstick the bot without deleting
  // history, and (b) the substring check tripped on maintainer comments
  // that merely mentioned the marker. Labels are atomic and parse-free.
  const attemptedAt = await getLabelAppliedAt(octokit, repo, issueNumber, 'fix-bot-attempted')
  if (attemptedAt) {
    const reopenedAt = await getReopenedAt(octokit, repo, issueNumber)
    const reopenedSinceAttempt = reopenedAt !== null && reopenedAt > attemptedAt
    if (!reopenedSinceAttempt) {
      printNotice(
        `#${issueNumber}: fix-bot-attempted label present and no reopen since. To re-attempt, remove the label OR reopen the issue.`,
      )
      return
    }
    printNotice(
      `#${issueNumber}: prior fix-bot-attempted (${attemptedAt}); issue reopened at ${reopenedAt}. Re-attempting.`,
    )
  }

  // Skip-list check (durable memory of "don't try this again"). Loaded
  // once per cron; checked against the current issue's fingerprint +
  // label/title metadata for rule matches.
  const skipList = readSkipList(SKIP_LIST_ABS)
  const fingerprint: IssueFingerprint = { issueNumber }
  const skipMatch = findSkipMatch(skipList, fingerprint, { title: issue.title, labels })
  if (skipMatch) {
    const reason = 'reason' in skipMatch ? skipMatch.reason : 'unknown'
    const note = 'reasonNote' in skipMatch ? skipMatch.reasonNote : '(no note)'
    printNotice(`#${issueNumber}: skip-list match (${reason}); skipping.`)
    printNotice(`  reason: ${note.slice(0, 120)}${note.length > 120 ? '…' : ''}`)
    return
  }

  if (DRY_RUN) {
    printNotice(`DRY_RUN=1 — exiting before invoking Claude.`)
    return
  }

  const branchName = `fix/issue-${issueNumber}`

  // Generator-critic loop. Up to MAX_ATTEMPTS iterations:
  //   1. Agent A (cleanup): reads issue + writes failing test + writes
  //      fix + commits locally (does NOT push)
  //   2. Agent B (reviewer): independent fresh-context judgment. Runs
  //      the tautology check (revert fix; test must still fail), the
  //      non-mechanical checks (root cause / scope / commit messages),
  //      and the project-rule check (on-demand reading of relevant
  //      team-preferences / design docs).
  //   3. Branch on reviewer verdict:
  //      APPROVE → push branch, open PR
  //      REJECT → reset working tree, retry with reviewer's note
  //      NEEDS_HUMAN → add skip-list entry, stop
  // Loop exhausts → skip-list entry ('needs-human').
  //
  // Both prompts get the lessons-learned doc inlined so Agent A can
  // avoid known recurring failure modes proactively.

  const agentAPromptTemplate = readFileSync(PROMPT_PATH, 'utf-8')
  const reviewerPromptTemplate = readFileSync(REVIEWER_PROMPT_PATH, 'utf-8')
  const lessonsLearned = existsSync(LESSONS_ABS) ? readFileSync(LESSONS_ABS, 'utf-8') : ''

  mkdirSync(TRANSCRIPTS_DIR, { recursive: true })
  const issueBody = issue.body ?? ''
  let priorReviewerNote: string | null = null
  let attemptOutcome: 'approved' | 'rejected-loop-exhausted' | 'needs-human' | 'agent-a-failure' = 'agent-a-failure'

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    printNotice(`Attempt ${attempt}/${MAX_ATTEMPTS}: invoking Agent A (cleanup)…`)

    // Reset to clean main between attempts. No-op on attempt 1 unless
    // a prior partial run left state behind. Defense-in-depth.
    resetToMain(branchName, { cwd: REPO_ROOT })

    const agentATranscript = resolve(
      TRANSCRIPTS_DIR,
      `${RUN_TIMESTAMP}-fix-issue-${issueNumber}-attempt${attempt}-A.jsonl`,
    )
    printTranscriptPath(agentATranscript)

    const agentAPrompt = `${agentAPromptTemplate}

ISSUE_NUMBER=${issueNumber}
ISSUE_TITLE=${issue.title}
ISSUE_BODY=
${issueBody}

BRANCH_NAME=${branchName}
ATTEMPT=${attempt}
MAX_ATTEMPTS=${MAX_ATTEMPTS}
${priorReviewerNote ? `PRIOR_REVIEWER_NOTE=${priorReviewerNote}\n\n` : ''}LESSONS_LEARNED=
${lessonsLearned}
RUN_ID=${process.env.GITHUB_RUN_ID ?? 'local'}`

    const aResult = await runClaude({
      prompt: agentAPrompt,
      transcriptPath: agentATranscript,
      allowedTools: ['Bash', 'Read', 'Grep', 'Glob', 'Write', 'Edit'],
    })

    if (!aResult.success) {
      printWarning(`Agent A exited ${aResult.exitCode} on attempt ${attempt}; posting failure comment.`)
      await postFailureComment(octokit, repo, issueNumber, agentATranscript)
      attemptOutcome = 'agent-a-failure'
      break
    }

    // What did Agent A produce? Three shapes possible:
    //   - STUCK: Agent A posted a stuck-comment + applied ready-for-human
    //     (existing path); no branch commits. We're done.
    //   - DELETE/FIX: Agent A committed two commits on $branchName.
    //     Reviewer turn.
    //   - Nothing (no commits, no stuck comment): edge case; treat as
    //     needs-human.
    const hasCommits = branchHasCommits(branchName, { cwd: REPO_ROOT })

    if (!hasCommits) {
      // Could be STUCK path (Agent A posted comment + applied label) or
      // a genuine no-op (Agent A bailed without doing anything).
      // Either way, this attempt is over and we don't loop — the
      // STUCK path is itself a terminal decision Agent A makes, not
      // a candidate for review.
      printNotice(
        `Agent A produced no commits on attempt ${attempt}; treating as Agent A's own decision (stuck or no-op).`,
      )
      attemptOutcome = 'agent-a-failure'
      break
    }

    // Reviewer turn.
    printNotice(`Attempt ${attempt}/${MAX_ATTEMPTS}: invoking Agent B (reviewer)…`)
    const diff = captureDiff(branchName, { cwd: REPO_ROOT })
    const commitMessages = captureCommitMessages(branchName, { cwd: REPO_ROOT })

    const reviewerTranscript = resolve(
      TRANSCRIPTS_DIR,
      `${RUN_TIMESTAMP}-fix-issue-${issueNumber}-attempt${attempt}-B.jsonl`,
    )
    printTranscriptPath(reviewerTranscript)

    const reviewerPrompt = `${reviewerPromptTemplate}

ISSUE_NUMBER=${issueNumber}
ISSUE_TITLE=${issue.title}
ISSUE_BODY=
${issueBody}

BRANCH_NAME=${branchName}
ATTEMPT=${attempt}
${priorReviewerNote ? `PRIOR_REVIEWER_NOTE=${priorReviewerNote}\n` : ''}
DIFF=
${diff}

COMMIT_MESSAGES=
${commitMessages}

RUN_ID=${process.env.GITHUB_RUN_ID ?? 'local'}`

    const bResult = await runClaude({
      prompt: reviewerPrompt,
      transcriptPath: reviewerTranscript,
      // Reviewer needs Bash to run the tautology check (git revert +
      // vitest), Read to inspect source + rule files on demand.
      // Explicitly NOT Write/Edit — reviewer doesn't modify code.
      allowedTools: ['Bash', 'Read'],
    })
    if (!bResult.success) {
      printWarning(`Agent B exited ${bResult.exitCode} on attempt ${attempt}; treating as needs-human.`)
      recordSkipListEntry(skipList, fingerprint, {
        reason: 'needs-human',
        reasonNote: `Reviewer crashed on attempt ${attempt}. See transcript ${reviewerTranscript}.`,
      })
      attemptOutcome = 'needs-human'
      break
    }

    // Parse the reviewer's final text block for the VERDICT line.
    const reviewerLastText = extractLastAssistantText(reviewerTranscript)
    const verdict = parseReviewerVerdict(reviewerLastText)

    if (verdict.kind === 'approve') {
      printNotice(`✅ Reviewer APPROVED on attempt ${attempt}/${MAX_ATTEMPTS}: ${verdict.reasoning.slice(0, 120)}`)
      pushBranch(branchName)
      openFixPR(
        repo,
        issueNumber,
        issue.title,
        branchName,
        verdict.reasoning,
        extractLastAssistantText(agentATranscript),
      )
      attemptOutcome = 'approved'
      break
    }

    if (verdict.kind === 'needs-human') {
      printWarning(`⚠ Reviewer escalated to NEEDS_HUMAN: ${verdict.note.slice(0, 120)}`)
      recordSkipListEntry(skipList, fingerprint, {
        reason: 'needs-human',
        reasonNote: `Reviewer verdict on attempt ${attempt}: ${verdict.note}`,
      })
      attemptOutcome = 'needs-human'
      break
    }

    // REJECT — loop with the reviewer's note for Agent A.
    printNotice(`Reviewer REJECTED on attempt ${attempt}/${MAX_ATTEMPTS}: ${verdict.note.slice(0, 120)}`)
    priorReviewerNote = verdict.note
  }

  if (attemptOutcome === 'agent-a-failure') {
    // Already-handled paths (stuck/no-op/crash); nothing more to do.
  } else if (attemptOutcome === 'needs-human') {
    // Already recorded a skip-list entry above; nothing more.
  } else if (attemptOutcome === 'approved') {
    // PR opened above; nothing more.
  } else {
    // Loop exhausted without convergence.
    printWarning(`Loop exhausted after ${MAX_ATTEMPTS} attempts — Agent A and reviewer didn't converge.`)
    recordSkipListEntry(skipList, fingerprint, {
      reason: 'needs-human',
      reasonNote: `Agent A and reviewer didn't converge after ${MAX_ATTEMPTS} attempts. Last reviewer note: ${priorReviewerNote ?? '(none)'}`,
    })
  }

  // Apply attempted-marker label whether the run succeeded or failed.
  // Compatibility with the legacy idempotency check above — a re-run
  // requires the maintainer to remove the label OR reopen the issue.
  try {
    await addLabel(octokit, repo, issueNumber, 'fix-bot-attempted')
  } catch (err) {
    printWarning(`could not apply fix-bot-attempted label to #${issueNumber}: ${err}`)
  }
}

/**
 * Push a branch to origin. Best-effort; failures log + continue.
 */
function pushBranch(branchName: string): void {
  try {
    execFileSync('git', ['push', '-u', 'origin', branchName], { cwd: REPO_ROOT, stdio: 'inherit' })
  } catch (err) {
    printWarning(`git push ${branchName} failed: ${err}`)
  }
}

/**
 * Open the fix-PR after reviewer approval. PR body cites both
 * Agent A's summary and Agent B's approve-reasoning so reviewers see
 * both perspectives.
 */
function openFixPR(
  _repo: RepoIdentity,
  issueNumber: number,
  issueTitle: string,
  branchName: string,
  reviewerReasoning: string,
  agentASummary: string,
): void {
  const body = `## Summary

Fixes #${issueNumber}.

After investigation by Agent A and independent review by Agent B (both
Claude Code sessions), this PR captures the bug as a failing test and
applies the fix.

## What Agent A did

${agentASummary || '(no Agent A summary captured)'}

## Reviewer's assessment

${reviewerReasoning || '(no reviewer reasoning captured)'}

The reviewer ran the tautology check (revert fix → test must fail; re-apply
fix → test must pass) plus the non-mechanical checks (root cause, scope
creep, commit message) and the project-rule check.

## Verification

This PR has two commits:
1. **Failing test** — captures the bug as a deterministic test
2. **Fix** — minimal change that turns the test green

CI re-verifies both commits.

## What if this is wrong?

Close the PR. The bot's feedback loop will read the close reason from
your comment and add a skip-list entry so it doesn't re-attempt the same
fix shape.

<!-- fix-bot: issue=${issueNumber} run=${process.env.GITHUB_RUN_ID ?? 'local'} -->`
  try {
    execFileSync(
      'gh',
      ['pr', 'create', '--title', `fix: ${issueTitle} (#${issueNumber})`, '--body', body, '--head', branchName],
      { cwd: REPO_ROOT, stdio: 'inherit' },
    )
  } catch (err) {
    printWarning(`gh pr create failed for #${issueNumber}: ${err}`)
  }
}

/**
 * Append a skip-list entry + persist. Used by reviewer-escalation
 * paths to record decisions durably.
 */
function recordSkipListEntry(
  skipList: SkipList,
  fingerprint: IssueFingerprint,
  opts: {
    reason: 'needs-human' | 'maintainer-rejected' | 'tautological-test' | 'wrong-root-cause'
    reasonNote: string
  },
): void {
  const added = appendEntry(skipList, {
    fingerprint,
    reason: opts.reason,
    reasonNote: opts.reasonNote,
    addedAt: new Date().toISOString(),
    addedBy: 'bot',
  })
  if (added) {
    writeSkipList(SKIP_LIST_ABS, skipList)
    printNotice(`Recorded skip-list entry for #${fingerprint.issueNumber} (${opts.reason})`)
  }
}

/**
 * Extract the last assistant text block from a JSONL transcript.
 * Returns empty string when no text block exists or the file can't
 * be read.
 */
function extractLastAssistantText(transcriptPath: string): string {
  try {
    const lines = readFileSync(transcriptPath, 'utf-8')
      .split('\n')
      .filter(l => l.trim().length > 0)
    let lastText = ''
    for (const line of lines) {
      try {
        const event = JSON.parse(line)
        if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
          for (const block of event.message.content) {
            if (block.type === 'text' && typeof block.text === 'string') {
              lastText = block.text
            }
          }
        }
      } catch {
        // ignore malformed line
      }
    }
    return lastText
  } catch {
    return ''
  }
}

/**
 * On non-zero Claude exit: read the transcript, extract a maintainer-
 * readable failure summary, post it as an issue comment, apply
 * `ready-for-human` so the candidate is removed from fix-bot's queue
 * until a human intervenes.
 *
 * Without this path, fix-bot failures leave the issue indistinguishable
 * from "never tried" — a black hole that requires the maintainer to
 * read workflow logs to diagnose.
 *
 * Best-effort: if the comment / label call itself fails (rare), log
 * and move on; the workflow log + transcript artifact still record what
 * happened.
 */
async function postFailureComment(
  octokit: ReturnType<typeof octokitFromEnv>,
  repo: ReturnType<typeof repoFromEnv>,
  issueNumber: number,
  transcriptPath: string,
): Promise<void> {
  try {
    const diagnostic = diagnoseFailure(transcriptPath)
    printNotice(`Failure category: ${diagnostic.category}`)

    const ghServer = process.env.GITHUB_SERVER_URL ?? 'https://github.com'
    const repoSlug = `${repo.owner}/${repo.repo}`
    const runId = process.env.GITHUB_RUN_ID ?? 'local'
    const workflowRunUrl =
      runId === 'local' ? '(local run — no workflow URL)' : `${ghServer}/${repoSlug}/actions/runs/${runId}`

    const body = formatFailureComment({ diagnostic, workflowRunUrl, runId })

    await octokit.issues.createComment({ ...repo, issue_number: issueNumber, body })
    await addLabel(octokit, repo, issueNumber, 'ready-for-human')
    printNotice(`Posted failure-diagnostic comment + applied ready-for-human on #${issueNumber}`)
  } catch (err) {
    printWarning(`Could not post failure comment on #${issueNumber}: ${err}`)
  }
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
