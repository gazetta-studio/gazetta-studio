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
import { detectRateLimit, runClaude } from '../_lib/claude.js'
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
import { parseReviewerTranscript } from '../_lib/reviewer-verdict.js'
import { collectAssistantTexts, extractSummary } from '../_lib/transcript.js'
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
import { pastPROutcome } from './past-pr.js'
import { appendReviewerLog, REVIEWER_LOG_PATH } from './reviewer-log.js'
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
const REVIEWER_LOG_ABS = resolve(REPO_ROOT, REVIEWER_LOG_PATH)
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

    let issueResult: IssueResult = { rateLimited: false }
    try {
      issueResult = await fixOneIssue(octokit, repo, candidate.number)
    } catch (err) {
      printWarning(`fix attempt for #${candidate.number} threw: ${err}; continuing.`)
    }
    processed++

    // Rate-limit cascade-stop. If Agent A hit Anthropic's session limit,
    // every subsequent candidate's `claude -p` invocation crashes in 4s
    // against the rejected bucket. Continuing the loop creates spurious
    // `ready-for-human` escalations + skip-list PRs (see 2026-06-14
    // #587-#590 in feature-bot). Stop the queue; tomorrow's cron resumes.
    if (issueResult.rateLimited) {
      const remaining = candidates.length - processed
      printWarning(
        `Stopping the candidate queue due to Anthropic session-rate-limit. ${remaining} candidate(s) remain; tomorrow's cron resumes after the bucket resets.`,
      )
      for (const skipped of candidates.slice(processed)) {
        console.log(`     ⏭  #${skipped.number} "${skipped.title}"`)
      }
      break
    }
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
/**
 * Result of attempting a single issue. The `rateLimited` flag tells the
 * outer candidate-loop to STOP processing the queue — every subsequent
 * issue would crash in seconds against the exhausted Anthropic session
 * bucket. Same shape + reasoning as feature-bot per rule 38 symmetric
 * audit. See `detectRateLimit` and the outer-loop check in `main`.
 */
type IssueResult = { rateLimited: boolean }

async function fixOneIssue(
  octokit: ReturnType<typeof octokitFromEnv>,
  repo: ReturnType<typeof repoFromEnv>,
  issueNumber: number,
): Promise<IssueResult> {
  const { data: issue } = await octokit.issues.get({ ...repo, issue_number: issueNumber })
  if (issue.pull_request) {
    printNotice(`#${issueNumber} is a pull request, not an issue. Skipping.`)
    return { rateLimited: false }
  }
  if (issue.state !== 'open') {
    printNotice(`#${issueNumber} is ${issue.state}; nothing to fix.`)
    return { rateLimited: false }
  }
  const labels = issue.labels.map(l => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean)
  if (!labels.includes('bug') || !labels.includes('ready-for-agent')) {
    printNotice(`#${issueNumber} lacks 'bug' + 'ready-for-agent' (current: [${labels.join(', ')}]); skipping.`)
    return { rateLimited: false }
  }
  if (labels.includes('ready-for-human') || labels.includes('wontfix') || labels.includes('needs-info')) {
    printNotice(`#${issueNumber} has terminal-state label; skipping.`)
    return { rateLimited: false }
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
      return { rateLimited: false }
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
    return { rateLimited: false }
  }

  // Past-PR feedback loop (rule 38 symmetric-bot audit — mirrors
  // dead-code-watcher's pastPROutcome check). Before attempting a
  // fresh fix, look up whether we previously filed a PR against
  // `fix/issue-<N>`:
  //   - open   → skip (don't double-PR while a review is in flight)
  //   - merged → no-op (issue should be closed; if not, maintainer knows)
  //   - rejected → mine maintainer's close-reason into the skip-list
  //                so the reason survives beyond runner teardown, then
  //                skip. Without this, close-reasons evaporate and the
  //                bot re-attempts the same fix shape on re-file.
  //   - none   → proceed.
  const past = await pastPROutcome(octokit, repo, issueNumber)
  if (past.state === 'open') {
    printNotice(`#${issueNumber}: PR #${past.prNumber} already open for this issue — skipping (waiting for review).`)
    return { rateLimited: false }
  }
  if (past.state === 'merged') {
    printNotice(`#${issueNumber}: PR #${past.prNumber} already merged — skipping (issue may just need closing).`)
    return { rateLimited: false }
  }
  if (past.state === 'rejected') {
    printNotice(`#${issueNumber}: prior PR #${past.prNumber} was rejected — adding skip-list entry from close-reason.`)
    const added = appendEntry(skipList, {
      fingerprint,
      reason: 'maintainer-rejected',
      reasonNote: past.reasonNote,
      addedAt: new Date().toISOString(),
      addedBy: 'bot',
      refPR: past.prNumber,
    })
    if (added) {
      writeSkipList(SKIP_LIST_ABS, skipList)
      await openPastPRSkipListPR(issueNumber, past.prNumber, past.reasonNote)
    }
    return { rateLimited: false }
  }

  // Lessons-learned is the durable cross-issue memory the monthly
  // compactor maintains. Loaded once per issue and inlined into every
  // Agent A + reviewer prompt. Loaded BEFORE the DRY_RUN exit so
  // dry-runs exercise the load path + report file size (catches
  // stale/corrupted lessons files early).
  const lessonsLearned = existsSync(LESSONS_ABS) ? readFileSync(LESSONS_ABS, 'utf-8') : ''
  printNotice(`Lessons file: ${lessonsLearned ? `${lessonsLearned.length} bytes` : 'absent'}`)

  if (DRY_RUN) {
    printNotice(`DRY_RUN=1 — exiting before invoking Claude.`)
    return { rateLimited: false }
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

  const agentAPromptTemplate = readFileSync(PROMPT_PATH, 'utf-8')
  const reviewerPromptTemplate = readFileSync(REVIEWER_PROMPT_PATH, 'utf-8')
  // lessonsLearned loaded above before DRY_RUN exit.

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
      // Rate-limit cascade-stop (rule 38 symmetric audit; mirrors
      // feature-bot's check). If Anthropic's 5-hour session bucket
      // is exhausted, every subsequent issue would crash in seconds.
      // Leave this issue on the queue + signal the outer loop to
      // STOP processing more candidates.
      if (detectRateLimit(agentATranscript)) {
        printWarning(
          `Anthropic session-rate-limit hit on attempt ${attempt}; stopping the queue (this issue + remaining candidates will be retried by tomorrow's cron after the bucket resets).`,
        )
        resetToMain(branchName, { cwd: REPO_ROOT })
        return { rateLimited: true }
      }
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

    const agentASummary = extractSummary(agentATranscript)
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

AGENT_A_SUMMARY=
${agentASummary || '(no SUMMARY block captured from Agent A — REJECT with note: your run did not emit a SUMMARY block; emit one per the per-issue prompt step 7)'}

RUN_ID=${process.env.GITHUB_RUN_ID ?? 'local'}`

    const bResult = await runClaude({
      prompt: reviewerPrompt,
      transcriptPath: reviewerTranscript,
      // Reviewer needs:
      //   - Bash for tautology check (git revert + vitest)
      //   - Read for source + rule files on demand
      //   - Agent for delegating review-architecture + review-security
      //     to subagents (keeps the skills' heavy context out of Agent
      //     B's window — without this delegation the skills' findings
      //     fence reads as a natural terminator and Agent B stops
      //     before emitting the required VERDICT: line; see #469)
      //   - Skill kept so the subagents (spawned via Agent) can invoke
      //     the skills they need
      // Explicitly NOT Write/Edit — reviewer doesn't modify code.
      allowedTools: ['Bash', 'Read', 'Agent', 'Skill'],
    })
    if (!bResult.success) {
      printWarning(`Agent B exited ${bResult.exitCode} on attempt ${attempt}; treating as needs-human.`)
      await escalateToHuman(octokit, repo, issueNumber, skipList, fingerprint, {
        reason: 'needs-human',
        reasonNote: `Reviewer crashed on attempt ${attempt}. See transcript ${reviewerTranscript}.`,
      })
      attemptOutcome = 'needs-human'
      break
    }

    // Parse the reviewer's final text block for the VERDICT line.
    // Search Agent B's FULL transcript for the VERDICT line — not just the
    // last block. Agent B is talkative; the verdict often lands in an
    // earlier block followed by a "Forming verdict." closing comment that
    // confused the original extractLastAssistantText-only parser.
    const reviewerTexts = collectAssistantTexts(reviewerTranscript)
    const verdict = parseReviewerTranscript(reviewerTexts)

    // Persist the verdict to reviewer-log.jsonl regardless of outcome.
    // The monthly compactor reads this raw signal and selects valuable
    // entries (reject→retry→approve sequences, substantive caveats,
    // genuine failure modes) for lessons-learned. Cheap append; the
    // value filter lives in the compactor, not here.
    try {
      appendReviewerLog(REVIEWER_LOG_ABS, {
        ts: new Date().toISOString(),
        runId: process.env.GITHUB_RUN_ID ?? 'local',
        fingerprint,
        fingerprintLabel: `#${issueNumber}`,
        attempt,
        verdict: verdict.kind === 'approve' ? 'approve' : verdict.kind === 'needs-human' ? 'needs-human' : 'reject',
        reasoning: verdict.kind === 'approve' ? verdict.reasoning : verdict.note,
        agentASummary,
      })
    } catch (err) {
      printWarning(`reviewer-log append failed (non-fatal): ${err}`)
    }

    if (verdict.kind === 'approve') {
      printNotice(`✅ Reviewer APPROVED on attempt ${attempt}/${MAX_ATTEMPTS}: ${verdict.reasoning.slice(0, 120)}`)
      pushBranch(branchName)
      openFixPR(repo, issueNumber, issue.title, branchName, verdict.reasoning, agentASummary)
      attemptOutcome = 'approved'
      break
    }

    if (verdict.kind === 'needs-human') {
      printWarning(`⚠ Reviewer escalated to NEEDS_HUMAN: ${verdict.note.slice(0, 120)}`)
      await escalateToHuman(octokit, repo, issueNumber, skipList, fingerprint, {
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
    await escalateToHuman(octokit, repo, issueNumber, skipList, fingerprint, {
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
  return { rateLimited: false }
}

/**
 * Push a branch to origin. Best-effort; failures log + continue.
 *
 * Force-with-lease so a re-attempt against a stale leftover branch of
 * the same name on origin (e.g. a prior run's `fix/issue-NNN` that
 * diverged) replaces it instead of silently failing as non-fast-forward
 * — the failure mode #550 documents for feature-bot. `--force-with-lease`
 * is safer than `--force`: it refuses to clobber an upstream that moved
 * unexpectedly. Sibling bots (feature-bot, review-bot, mutation-area-
 * picker) all push this way per team-preferences rule 38.
 */
function pushBranch(branchName: string): void {
  try {
    execFileSync('git', ['push', '-u', '--force-with-lease', 'origin', branchName], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    })
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
fix → test must pass), verified Agent A's declared \`Mode:\` matches the
diff (behavioral / structural / mixed), checked the runtime exercise
proves each fix-touched path (when behavioral), and ran the non-mechanical
checks (root cause, scope creep, commit message).

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
      [
        'pr',
        'create',
        '--draft',
        '--title',
        `fix: ${issueTitle} (#${issueNumber})`,
        '--body',
        body,
        '--head',
        branchName,
      ],
      { cwd: REPO_ROOT, stdio: 'inherit' },
    )
  } catch (err) {
    printWarning(`gh pr create failed for #${issueNumber}: ${err}`)
  }
}

/**
 * Open a tiny draft PR containing just the skip-list update mined
 * from a maintainer-rejected PR's close-reason. Without this PR the
 * skip-list write lives only on the runner's ephemeral filesystem
 * and vanishes at workflow teardown — the next cron re-attempts the
 * same fix shape (the very failure mode rule 38 documents against).
 *
 * Best-effort: on failure the in-memory skip-list is still updated
 * for THIS run; the next run will retry filing the PR via the same
 * past-PR loop when it re-observes the rejected upstream PR.
 */
async function openPastPRSkipListPR(issueNumber: number, rejectedPR: number, reasonNote: string): Promise<void> {
  const dateStr = new Date().toISOString().slice(0, 10)
  const skipBranch = `fix-bot-skip/${dateStr}-issue-${issueNumber}-past-pr`
  try {
    execFileSync('git', ['checkout', '-b', skipBranch], { cwd: REPO_ROOT, stdio: 'inherit' })
    execFileSync('git', ['add', SKIP_LIST_PATH], { cwd: REPO_ROOT, stdio: 'inherit' })
    execFileSync(
      'git',
      [
        'commit',
        '-m',
        `chore(skip-list): record maintainer rejection of fix for #${issueNumber}\n\nMined from PR #${rejectedPR} close-reason: ${reasonNote.slice(0, 300)}`,
      ],
      { cwd: REPO_ROOT, stdio: 'inherit' },
    )
    execFileSync('git', ['push', '-u', '--force-with-lease', 'origin', skipBranch], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    })
    execFileSync(
      'gh',
      [
        'pr',
        'create',
        '--draft',
        '--title',
        `chore(skip-list): record rejection of fix for #${issueNumber}`,
        '--body',
        `> *This was generated by AI during triage.*

Adds a skip-list entry so fix-bot doesn't re-attempt the same fix shape for #${issueNumber} on every cron.

**Source of rejection:** PR #${rejectedPR}

**Reason mined from maintainer's close-reason:**

> ${reasonNote}

**What to do next:**

- If the rejection was correct and the issue should stay closed / re-scoped / re-designed → merge this PR (durable skip).
- If the rejection was on a specific fix shape but the underlying bug still needs fixing (with a different approach) → merge this PR AND leave a new comment on #${issueNumber} describing the alternate shape; then remove the \`fix-bot-attempted\` label so a fresh cron tries the new direction (the skip-list entry pins the old shape via reasonNote so the bot won't repeat it).
- If mining picked the wrong comment as the rejection reason → close this PR and edit the skip-list manually.

<!-- fix-bot: skip-entry issue=${issueNumber} source-pr=${rejectedPR} reason=maintainer-rejected -->`,
      ],
      { cwd: REPO_ROOT, stdio: 'inherit' },
    )
  } catch (err) {
    printWarning(`Couldn't open skip-list PR for #${issueNumber} (past-PR): ${err}`)
  } finally {
    try {
      execFileSync('git', ['checkout', 'main'], { cwd: REPO_ROOT, stdio: 'inherit' })
    } catch {
      // best-effort
    }
  }
}

/**
 * Reviewer-loop escalation: the bot can't proceed and humans must
 * intervene. Does FOUR things to make the failure visible:
 *
 *   1. Append entry to skip-list.json locally
 *   2. Open a draft PR with that skip-list entry (so next run honors it)
 *   3. Post a stuck-comment on the issue explaining why the bot stopped
 *   4. Apply `ready-for-human` label (removes from fix-bot's queue)
 *
 * Without steps 2-4, the only memory of the bot's reviewer loop is the
 * runner-local skip-list.json that vanishes on workflow teardown.
 * That's the bug that caused #414/#415 to sit silently for 6 days
 * after fix-bot's reviewer loop produced substantive (but
 * unparseable) verdicts on 2026-05-23. See run 26325999185 + ADR
 * trail for context.
 *
 * Best-effort throughout: a PR-creation failure doesn't block the
 * issue-comment; a comment failure doesn't block the label. Workflow
 * log + transcript artifact remain the forensic record either way.
 */
async function escalateToHuman(
  octokit: ReturnType<typeof octokitFromEnv>,
  repo: ReturnType<typeof repoFromEnv>,
  issueNumber: number,
  skipList: SkipList,
  fingerprint: IssueFingerprint,
  opts: {
    reason: 'needs-human' | 'maintainer-rejected' | 'tautological-test' | 'wrong-root-cause'
    reasonNote: string
  },
): Promise<void> {
  // Step 1: write skip-list locally
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

  // Step 2: open draft PR for the skip-list change so it lands on main.
  // Otherwise the runner-local write evaporates at workflow teardown.
  const dateStr = new Date().toISOString().slice(0, 10)
  const skipBranch = `fix-bot-skip/${dateStr}-issue-${issueNumber}`
  try {
    execFileSync('git', ['checkout', '-b', skipBranch], { cwd: REPO_ROOT, stdio: 'inherit' })
    execFileSync('git', ['add', SKIP_LIST_PATH], { cwd: REPO_ROOT, stdio: 'inherit' })
    execFileSync(
      'git',
      [
        'commit',
        '-m',
        `chore(skip-list): record ${opts.reason} for #${issueNumber}\n\n${opts.reasonNote.slice(0, 500)}`,
      ],
      { cwd: REPO_ROOT, stdio: 'inherit' },
    )
    execFileSync('git', ['push', '-u', '--force-with-lease', 'origin', skipBranch], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    })
    execFileSync(
      'gh',
      [
        'pr',
        'create',
        '--draft',
        '--title',
        `chore(skip-list): record ${opts.reason} for #${issueNumber}`,
        '--body',
        `> *This was generated by AI during triage.*

Adds a skip-list entry so fix-bot doesn't re-attempt issue #${issueNumber} on every cron.

**Reason:** \`${opts.reason}\`

**Note from the reviewer loop:**

> ${opts.reasonNote.slice(0, 1500)}

**What to do next:**

Read the comment fix-bot just posted on #${issueNumber}. If the reviewer's reasoning looks right, either merge this PR (durable skip), close the underlying issue, or open the fix yourself based on the reviewer's analysis. If the reviewer was wrong, close this PR and reopen #${issueNumber} (or remove the \`ready-for-human\` label) to let fix-bot retry.

<!-- fix-bot: skip-entry issue=${issueNumber} reason=${opts.reason} run=${process.env.GITHUB_RUN_ID ?? 'local'} -->`,
      ],
      { cwd: REPO_ROOT, stdio: 'inherit' },
    )
    printNotice(`Opened skip-list-entry PR for #${issueNumber}`)
  } catch (err) {
    printWarning(`Couldn't open skip-list PR for #${issueNumber}: ${err}`)
  } finally {
    try {
      execFileSync('git', ['checkout', 'main'], { cwd: REPO_ROOT, stdio: 'inherit' })
    } catch {
      // best-effort
    }
  }

  // Step 3 + 4: post stuck-comment + apply ready-for-human label so the
  // issue moves off fix-bot's queue and gives the maintainer a single
  // place to see what happened (rather than digging in workflow logs).
  try {
    const ghServer = process.env.GITHUB_SERVER_URL ?? 'https://github.com'
    const repoSlug = `${repo.owner}/${repo.repo}`
    const runId = process.env.GITHUB_RUN_ID ?? 'local'
    const workflowRunUrl =
      runId === 'local' ? '(local run — no workflow URL)' : `${ghServer}/${repoSlug}/actions/runs/${runId}`

    const body = `> *This was generated by AI during triage.*

⚠ **Fix-bot reviewer-loop escalation — needs human attention.**

**Reason:** \`${opts.reason}\`

**Note from the reviewer:**

> ${opts.reasonNote.slice(0, 2000)}

**Workflow run:** ${workflowRunUrl}

I've stopped attempting this issue and applied \`ready-for-human\` (removing it from my queue). Next steps for the maintainer:

1. **Read the reviewer's full reasoning** in the workflow run's transcript artifact (\`bots/transcripts/\`) — substantive analysis often lives there.
2. **If the reviewer was right** — close this issue OR open the fix manually based on the reviewer's analysis.
3. **If you want me to retry** — remove the \`ready-for-human\` label AND the \`fix-bot-attempted\` label. (Or close the skip-list-PR I just opened.)

<!-- fix-bot: escalation issue=${issueNumber} reason=${opts.reason} run=${runId} -->`

    await octokit.issues.createComment({ ...repo, issue_number: issueNumber, body })
    await addLabel(octokit, repo, issueNumber, 'ready-for-human')
    printNotice(`Posted escalation comment + applied ready-for-human on #${issueNumber}`)
  } catch (err) {
    printWarning(`Could not post escalation comment on #${issueNumber}: ${err}`)
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
