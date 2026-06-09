/**
 * feature-bot — implements `enhancement + ready-for-agent` cut sub-issues.
 *
 * Per design-feature-bot.md, feature-bot is a producer bot that reads
 * cut sub-issues from GitHub (per Q1: cuts live in tracking issues +
 * sub-issues, not in `.claude/rules/design-*-implementation.md` tables)
 * and ships one PR per cut via a generator-critic loop (per Q6: Agent A
 * implements, Agent B reviews, three-tier escalation
 * APPROVE / NEEDS_INPUT / NEEDS_HUMAN).
 *
 * # Cut 3 status (this file)
 *
 * Cut 3 ships the full generator-critic loop + three-tier escalation.
 * Cuts 1+2 shipped the skeleton + cut-parser respectively. Cut 4 will
 * ship the workflow + cron.
 *
 * # Two trigger modes
 *
 *   1. Cron (default): scans for `enhancement + ready-for-agent` issues
 *      that lack `ready-for-human` / `wontfix` / `needs-info`.
 *   2. Manual via `ISSUE_NUMBER` env: attempt a single specific sub-issue.
 *
 * # Per-cut, the bot:
 *   1. Validates the cut sub-issue body + dep refs via
 *      `validateCutSubIssue` (pre-Claude gate per Q3).
 *   2. Checks idempotency via `decideIdempotency`.
 *   3. Loads lessons-learned (currently empty placeholder).
 *   4. Generator-critic loop (MAX_ATTEMPTS=5):
 *      - Agent A reads design doc + cut body, builds + self-checks, then one commit.
 *      - Agent A signals: APPROVE_IMPLICIT (commits) / NEEDS_INPUT / NEEDS_HUMAN.
 *      - On APPROVE_IMPLICIT: Agent B reviews + verdicts.
 *      - `routeAttemptOutcome` decides the next step.
 *   5. Routes to: push-and-pr / retry-with-note / post-input-question /
 *      escalate-needs-human / escalate-failure.
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
  removeLabel,
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
import { parseAgentASignal } from './agent-a-signal.js'
import { decideIdempotency } from './idempotency.js'
import { appendReviewerLog, REVIEWER_LOG_PATH } from './reviewer-log.js'
import { routeAttemptOutcome, type AttemptOutcome, type RouteContext, type RouteDecision } from './route-attempt.js'
import {
  appendEntry,
  findSkipMatch,
  type IssueFingerprint,
  readSkipList,
  type SkipList,
  type SkipListEntry,
  type SkipReason,
  SKIP_LIST_PATH,
  writeSkipList,
} from './skip-list.js'
import { validateCutSubIssue } from './validate-cut-sub-issue.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = resolve(HERE, 'prompts/per-cut.md')
const REVIEWER_PROMPT_PATH = resolve(HERE, 'prompts/reviewer.md')
const REPO_ROOT = resolve(HERE, '../..')
const SKIP_LIST_ABS = resolve(REPO_ROOT, SKIP_LIST_PATH)
const REVIEWER_LOG_ABS = resolve(REPO_ROOT, REVIEWER_LOG_PATH)
const LESSONS_PATH = 'bots/feature-bot/lessons-learned.md'
const LESSONS_ABS = resolve(REPO_ROOT, LESSONS_PATH)

const DRY_RUN = process.env.DRY_RUN === '1'
const TRANSCRIPTS_DIR = resolve(HERE, '../transcripts')
const RUN_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')

const PER_RUN_BUDGET_MS = Number(process.env.BUDGET_MS ?? 50 * 60 * 1000)
// Per-CUT wall-clock budget, checked at the top of each generator-critic
// attempt. The per-RUN budget above only fires BETWEEN candidates, so a
// single thrashing cut (e.g. an RBAC cut whose Agent-A pipeline +
// Agent-B architecture-review subagent + retries exceed the budget within
// one cut) would otherwise run until the workflow's `timeout-minutes: 60`
// HARD-KILLS it mid-attempt — producing NO PR, NO escalation, no record
// (the #516 failure mode, 2026-06-09). Capping per-cut well under the
// 60-min wall converts that silent kill into a graceful NEEDS_HUMAN
// escalation ("cut exceeds time budget — likely too large; split it").
const PER_CUT_BUDGET_MS = Number(process.env.CUT_BUDGET_MS ?? 45 * 60 * 1000)
const PROCESS_START = Date.now()
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS ?? '5')
const MAX_INPUT_CYCLES = Number(process.env.MAX_INPUT_CYCLES ?? '2')

async function main(): Promise<void> {
  const repo = repoFromEnv()
  const octokit = octokitFromEnv()

  const issueNumberStr = process.env.ISSUE_NUMBER
  if (issueNumberStr) {
    if (!/^\d+$/.test(issueNumberStr)) {
      console.error(`ISSUE_NUMBER='${issueNumberStr}' must be a positive integer`)
      process.exit(2)
    }
    await fixOneCut(octokit, repo, Number(issueNumberStr))
    return
  }

  printBanner({
    name: 'feature-bot',
    tagline: 'implementer (Cut 3 — generator-critic loop)',
    purpose: 'Implement `enhancement + ready-for-agent` cut sub-issues (build → SOLID → runtime validation → improve tests → verify comments → one commit).',
    inputs: [
      'Open issues with `enhancement` AND `ready-for-agent`',
      'AND no `ready-for-human` / `wontfix` / `needs-info`',
    ],
    outputs: [
      'EITHER draft PR (commit 1: failing test, commit 2: impl)',
      'OR NEEDS_INPUT comment + `needs-info` label (design question)',
      'OR escalation comment + `ready-for-human` label + skip-list PR',
    ],
  })

  printNotice(`Scanning ${repo.owner}/${repo.repo} for enhancement+ready-for-agent cut sub-issues`)

  const allCandidates = await findIssuesByLabels(octokit, repo, {
    requireAll: ['enhancement', 'ready-for-agent'],
    excludeAny: ['ready-for-human', 'wontfix', 'needs-info'],
  })

  if (allCandidates.length === 0) {
    printNotice('No feature-bot candidates found. Inbox zero — nothing to do. ✨')
    return
  }

  // Q4 lock: oldest-first sort, deterministic tiebreaker by issue number.
  const candidates = [...allCandidates].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt.localeCompare(b.createdAt)
    return a.number - b.number
  })

  printCandidateList({
    noun: 'cut sub-issue',
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
        `Per-run budget exhausted (${Math.round(elapsed / 1000)}s > ${Math.round(PER_RUN_BUDGET_MS / 1000)}s). Stopping with ${remaining} unprocessed; tomorrow's run picks them up.`,
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
      await fixOneCut(octokit, repo, candidate.number)
    } catch (err) {
      printWarning(`Cut attempt for #${candidate.number} threw: ${err}; continuing.`)
    }
    processed++
  }

  const totalSec = Math.round((Date.now() - runStart) / 1000)
  printRunSummary({
    verb: 'Processed',
    processed,
    total: candidates.length,
    skipped: candidates.length - processed,
    elapsedSec: totalSec,
  })
}

/**
 * Attempt to implement one cut sub-issue. Used by cron mode (per-candidate
 * loop) and manual one-issue mode.
 */
async function fixOneCut(
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
    printNotice(`#${issueNumber} is ${issue.state}; nothing to do.`)
    return
  }
  const labels = issue.labels.map(l => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean)
  if (!labels.includes('enhancement') || !labels.includes('ready-for-agent')) {
    printNotice(`#${issueNumber} lacks 'enhancement' + 'ready-for-agent' (current: [${labels.join(', ')}]); skipping.`)
    return
  }
  if (labels.includes('ready-for-human') || labels.includes('wontfix') || labels.includes('needs-info')) {
    printNotice(`#${issueNumber} has terminal-state label; skipping.`)
    return
  }

  // Idempotency: skip if the `feature-bot-attempted` label is present AND
  // the issue hasn't been reopened since the label was applied.
  // Mirrors fix-bot's auto-clear-on-reopen pattern (rule 38 symmetric audit).
  const attemptedAt = await getLabelAppliedAt(octokit, repo, issueNumber, 'feature-bot-attempted')
  const reopenedAt = attemptedAt !== null ? await getReopenedAt(octokit, repo, issueNumber) : null
  const idempotencyDecision = decideIdempotency({ attemptedAt, reopenedAt })
  if (idempotencyDecision.kind === 'skip') {
    printNotice(
      `#${issueNumber}: feature-bot-attempted label present and no reopen since. To re-attempt, remove the label OR reopen the issue.`,
    )
    return
  }
  if (idempotencyDecision.kind === 'proceed-after-reopen') {
    printNotice(
      `#${issueNumber}: prior feature-bot-attempted (${attemptedAt}); reopened at ${reopenedAt}. Re-attempting.`,
    )
  }

  // Pre-Claude gate: parse body + validate deps. Loud-fail on bad refs.
  const issueBody = issue.body ?? ''
  const validation = await validateCutSubIssue(octokit as never, repo, issueNumber, issueBody)

  if (validation.kind === 'body-error') {
    await postBodyErrorComment(octokit, repo, issueNumber, validation.errors)
    await applyLabelBestEffort(octokit, repo, issueNumber, 'needs-info')
    await applyLabelBestEffort(octokit, repo, issueNumber, 'feature-bot-attempted')
    return
  }

  if (validation.kind === 'self-reference') {
    const skipList = readSkipList(SKIP_LIST_ABS)
    await escalateToHuman(
      octokit,
      repo,
      issueNumber,
      skipList,
      { issueNumber },
      {
        reason: 'spec-too-vague',
        reasonNote: `Cut body references its own issue number in **Depends on**. This is a structurally broken spec.`,
      },
    )
    return
  }

  if (validation.kind === 'dep-invalid') {
    await postDepInvalidComment(octokit, repo, issueNumber, validation.depNumber, validation.reason)
    await applyLabelBestEffort(octokit, repo, issueNumber, 'needs-info')
    await applyLabelBestEffort(octokit, repo, issueNumber, 'feature-bot-attempted')
    return
  }

  if (validation.kind === 'dep-rejected') {
    const skipList = readSkipList(SKIP_LIST_ABS)
    await escalateToHuman(
      octokit,
      repo,
      issueNumber,
      skipList,
      { issueNumber },
      {
        reason: 'missing-prereq',
        reasonNote: `Cut depends on #${validation.depNumber} which was closed without merging. The prerequisite work was rejected; this cut may need re-scoping.`,
      },
    )
    return
  }

  if (validation.kind === 'dep-open') {
    // No labels applied — bot retries next cron when dep closes.
    await postDepOpenComment(octokit, repo, issueNumber, validation.openDeps)
    return
  }

  // validation.kind === 'ready'
  const parsed = validation.parsed
  const featureSlug = parsed.feature ?? 'unknown'

  // Skip-list check (durable memory of "don't try this again").
  const skipList = readSkipList(SKIP_LIST_ABS)
  const fingerprint: IssueFingerprint = { issueNumber }
  const skipMatch = findSkipMatch(skipList, fingerprint)
  if (skipMatch) {
    printNotice(`#${issueNumber}: skip-list match (${skipMatch.reason}); skipping.`)
    return
  }

  // Lessons-learned — loaded once, inlined into every Agent A + reviewer prompt.
  const lessonsLearned = existsSync(LESSONS_ABS) ? readFileSync(LESSONS_ABS, 'utf-8') : ''
  printNotice(`Lessons file: ${lessonsLearned ? `${lessonsLearned.length} bytes` : 'absent'}`)

  // Count prior NEEDS_INPUT cycles via outcome-tag query on existing comments.
  const priorInputCycles = await countPriorInputCycles(octokit, repo, issueNumber)
  if (priorInputCycles > 0) {
    printNotice(`#${issueNumber}: ${priorInputCycles} prior NEEDS_INPUT cycle(s) recorded.`)
  }

  const branchName = `feat/cut-${issueNumber}`

  const agentAPromptTemplate = readFileSync(PROMPT_PATH, 'utf-8')
  const reviewerPromptTemplate = readFileSync(REVIEWER_PROMPT_PATH, 'utf-8')

  mkdirSync(TRANSCRIPTS_DIR, { recursive: true })
  let priorReviewerNote: string | null = null
  let finalOutcome: 'approved' | 'escalated' | 'needs-input-posted' | 'loop-exhausted' = 'loop-exhausted'

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Per-cut deadline guard. Without this, a thrashing cut runs until the
    // workflow's 60-min hard kill, producing nothing (the #516 failure
    // mode). Check BEFORE each attempt: if we'd likely not finish another
    // generator-critic round before the budget, stop and escalate so the
    // cut is recorded as needing human attention (probably too large —
    // split it) instead of vanishing into a silent timeout.
    //
    // LIMITATION: this fires only BETWEEN attempts. A single attempt
    // (one Agent A pipeline + one Agent B review) that alone exceeds the
    // budget still gets hard-killed mid-attempt — the guard can't
    // interrupt an in-flight runClaude. It catches the common multi-
    // attempt-thrash case; per-call timeouts on runClaude are the fuller
    // fix if single-attempt overruns recur.
    const cutElapsed = Date.now() - PROCESS_START
    if (cutElapsed > PER_CUT_BUDGET_MS) {
      printWarning(
        `Per-cut budget exhausted for #${issueNumber} (${Math.round(cutElapsed / 1000)}s > ${Math.round(PER_CUT_BUDGET_MS / 1000)}s) after ${attempt - 1} attempt(s). Escalating before the workflow hard-kill.`,
      )
      resetToMain(branchName, { cwd: REPO_ROOT })
      await escalateToHuman(octokit, repo, issueNumber, skipList, fingerprint, {
        reason: 'needs-human',
        reasonNote: `Cut exceeded the per-cut time budget (${Math.round(PER_CUT_BUDGET_MS / 60000)} min) after ${attempt - 1} generator-critic attempt(s) without an APPROVE. The cut is likely too large or the loop is thrashing — consider splitting it into smaller cuts or tightening its spec. (Stopped before the workflow's 60-min hard-kill to leave a record instead of a silent timeout.)`,
      })
      finalOutcome = 'escalated'
      break
    }
    printNotice(`Attempt ${attempt}/${MAX_ATTEMPTS}: invoking Agent A…`)
    resetToMain(branchName, { cwd: REPO_ROOT })

    const agentATranscript = resolve(
      TRANSCRIPTS_DIR,
      `${RUN_TIMESTAMP}-feature-cut-${issueNumber}-attempt${attempt}-A.jsonl`,
    )
    printTranscriptPath(agentATranscript)

    const agentAPrompt = `${agentAPromptTemplate}

ISSUE_NUMBER=${issueNumber}
ISSUE_TITLE=${issue.title}
FEATURE_SLUG=${featureSlug}
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

    const ctx: RouteContext = {
      attempt,
      maxAttempts: MAX_ATTEMPTS,
      priorInputCycles,
      maxInputCycles: MAX_INPUT_CYCLES,
    }

    let outcome: AttemptOutcome
    if (!aResult.success) {
      outcome = { kind: 'agent-a-failure', exitCode: aResult.exitCode }
    } else {
      const agentATexts = collectAssistantTexts(agentATranscript)
      const lastText = agentATexts.at(-1) ?? ''
      const signal = parseAgentASignal(lastText)

      if (signal.kind === 'needs-input' || signal.kind === 'needs-human') {
        outcome = { kind: 'agent-a-signaled', signal }
      } else {
        // approve-implicit — Agent A should have committed work.
        const hasCommits = branchHasCommits(branchName, { cwd: REPO_ROOT })
        if (!hasCommits) {
          outcome = { kind: 'agent-a-no-output' }
        } else {
          // Invoke Agent B.
          printNotice(`Attempt ${attempt}/${MAX_ATTEMPTS}: invoking Agent B (reviewer)…`)
          const diff = captureDiff(branchName, { cwd: REPO_ROOT })
          const commitMessages = captureCommitMessages(branchName, { cwd: REPO_ROOT })
          const reviewerTranscript = resolve(
            TRANSCRIPTS_DIR,
            `${RUN_TIMESTAMP}-feature-cut-${issueNumber}-attempt${attempt}-B.jsonl`,
          )
          printTranscriptPath(reviewerTranscript)

          const agentASummary = extractSummary(agentATranscript)
          const reviewerPrompt = `${reviewerPromptTemplate}

ISSUE_NUMBER=${issueNumber}
ISSUE_TITLE=${issue.title}
FEATURE_SLUG=${featureSlug}
ISSUE_BODY=
${issueBody}

BRANCH_NAME=${branchName}
ATTEMPT=${attempt}
${priorReviewerNote ? `PRIOR_REVIEWER_NOTE=${priorReviewerNote}\n` : ''}DIFF=
${diff}

COMMIT_MESSAGES=
${commitMessages}

AGENT_A_SUMMARY=
${agentASummary || '(no SUMMARY block captured from Agent A — REJECT with note: your run did not emit a SUMMARY block; emit one per the per-cut prompt APPROVE-path step 10)'}

RUN_ID=${process.env.GITHUB_RUN_ID ?? 'local'}`

          const bResult = await runClaude({
            prompt: reviewerPrompt,
            transcriptPath: reviewerTranscript,
            // Reviewer needs:
            //   - Bash for tautology check (git revert + vitest)
            //   - Read for source + rule files on demand
            //   - Agent for delegating review-architecture +
            //     review-security to subagents (keeps the skills'
            //     heavy context out of Agent B's window — same
            //     pattern fix-bot adopted in #471 after the VERDICT
            //     line was getting eaten by the findings fence)
            //   - Skill kept so the subagents (spawned via Agent)
            //     can invoke the skills they need
            // Explicitly NOT Write/Edit — reviewer doesn't modify code.
            allowedTools: ['Bash', 'Read', 'Agent', 'Skill'],
          })
          if (!bResult.success) {
            printWarning(`Agent B exited ${bResult.exitCode} on attempt ${attempt}; treating as needs-human.`)
            await escalateToHuman(octokit, repo, issueNumber, skipList, fingerprint, {
              reason: 'needs-human',
              reasonNote: `Reviewer crashed on attempt ${attempt}. See transcript ${reviewerTranscript}.`,
            })
            finalOutcome = 'escalated'
            break
          }

          const reviewerTexts = collectAssistantTexts(reviewerTranscript)
          const verdict = parseReviewerTranscript(reviewerTexts)

          try {
            appendReviewerLog(REVIEWER_LOG_ABS, {
              ts: new Date().toISOString(),
              runId: process.env.GITHUB_RUN_ID ?? 'local',
              fingerprint,
              fingerprintLabel: `#${issueNumber}`,
              attempt,
              verdict:
                verdict.kind === 'approve' ? 'approve' : verdict.kind === 'needs-human' ? 'needs-human' : 'reject',
              reasoning: verdict.kind === 'approve' ? verdict.reasoning : verdict.note,
              agentASummary: extractSummary(agentATranscript),
            })
          } catch (err) {
            printWarning(`reviewer-log append failed (non-fatal): ${err}`)
          }

          outcome = { kind: 'agent-b-judged', signal, verdict }
        }
      }
    }

    const decision = routeAttemptOutcome(outcome, ctx)

    if (decision.kind === 'push-and-pr') {
      printNotice(`✅ Reviewer APPROVED on attempt ${attempt}/${MAX_ATTEMPTS}: ${decision.reasoning.slice(0, 120)}`)
      pushBranch(branchName)
      openCutPR(
        repo,
        issueNumber,
        issue.title,
        featureSlug,
        branchName,
        decision.reasoning,
        extractSummary(
          resolve(TRANSCRIPTS_DIR, `${RUN_TIMESTAMP}-feature-cut-${issueNumber}-attempt${attempt}-A.jsonl`),
        ),
      )
      finalOutcome = 'approved'
      break
    }

    if (decision.kind === 'retry-with-note') {
      printNotice(`Reviewer REJECTED on attempt ${attempt}/${MAX_ATTEMPTS}: ${decision.note.slice(0, 120)}`)
      priorReviewerNote = decision.note
      continue
    }

    if (decision.kind === 'post-input-question') {
      printNotice(`Agent A asked NEEDS_INPUT: ${decision.question.slice(0, 120)}`)
      await postInputQuestion(octokit, repo, issueNumber, decision.body)
      await applyLabelBestEffort(octokit, repo, issueNumber, 'needs-info')
      resetToMain(branchName, { cwd: REPO_ROOT })
      finalOutcome = 'needs-input-posted'
      break
    }

    if (decision.kind === 'escalate-needs-human') {
      printWarning(`⚠ Escalating to NEEDS_HUMAN (reason=${decision.reason}): ${decision.reasonNote.slice(0, 120)}`)
      await escalateToHuman(octokit, repo, issueNumber, skipList, fingerprint, {
        reason: decision.reason,
        reasonNote: decision.reasonNote,
      })
      finalOutcome = 'escalated'
      break
    }

    if (decision.kind === 'escalate-failure') {
      printWarning(`Agent A exited ${decision.exitCode} on attempt ${attempt}; escalating.`)
      await escalateToHuman(octokit, repo, issueNumber, skipList, fingerprint, {
        reason: 'needs-human',
        reasonNote: `Agent A's Claude invocation exited ${decision.exitCode} on attempt ${attempt}. See transcript.`,
      })
      finalOutcome = 'escalated'
      break
    }
  }

  // If we fell through without break, the loop hit MAX_ATTEMPTS with all
  // REJECT verdicts (handled inside the loop on the last iteration via
  // attempt >= maxAttempts in routeAttemptOutcome). But the no-break path
  // here is defense-in-depth.
  if (finalOutcome === 'loop-exhausted') {
    printWarning(`Loop exhausted after ${MAX_ATTEMPTS} attempts.`)
    await escalateToHuman(octokit, repo, issueNumber, skipList, fingerprint, {
      reason: 'needs-human',
      reasonNote: `Loop exhausted after ${MAX_ATTEMPTS} attempts. Last reviewer note: ${priorReviewerNote ?? '(none)'}`,
    })
  }

  await applyLabelBestEffort(octokit, repo, issueNumber, 'feature-bot-attempted')
}

/**
 * Count prior NEEDS_INPUT cycles for this cut sub-issue.
 *
 * Reads existing comments and counts those with the outcome tag
 * `<!-- feature-bot: needs-input issue=N run=R -->`. Used to enforce
 * MAX_INPUT_CYCLES per Q6 lock.
 */
async function countPriorInputCycles(
  octokit: ReturnType<typeof octokitFromEnv>,
  repo: RepoIdentity,
  issueNumber: number,
): Promise<number> {
  const { data: comments } = await octokit.issues.listComments({
    ...repo,
    issue_number: issueNumber,
    per_page: 100,
  })
  const marker = `feature-bot: needs-input issue=${issueNumber}`
  return comments.filter(c => (c.body ?? '').includes(marker)).length
}

function pushBranch(branchName: string): void {
  try {
    // Force-with-lease so a freshly-built branch (created from origin/main
    // this run) always replaces any STALE leftover of the same name on
    // origin from a prior run. A plain `git push` would be rejected as
    // non-fast-forward against a diverged stale branch and the PR would
    // then point at the stale commits (the bug behind #550). `--force-
    // with-lease` is safe here: feature-bot owns `feat/cut-NNN` branches,
    // and lease still guards against clobbering a push we didn't expect.
    execFileSync('git', ['push', '-u', '--force-with-lease', 'origin', branchName], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    })
  } catch (err) {
    printWarning(`git push ${branchName} failed: ${err}`)
  }
}

function openCutPR(
  _repo: RepoIdentity,
  issueNumber: number,
  issueTitle: string,
  featureSlug: string,
  branchName: string,
  reviewerReasoning: string,
  agentASummary: string,
): void {
  const body = `## Summary

Implements cut #${issueNumber} for the \`${featureSlug}\` feature.

Closes #${issueNumber}.

Implemented by Agent A, then independently reviewed by Agent B (both
Claude Code sessions). Agent A's flow: write tests + impl, SOLID
research+fix, runtime validation, improve/fix tests, verify comments —
then one atomic commit.

## What Agent A did

${agentASummary || '(no Agent A summary captured)'}

## Reviewer's assessment

${reviewerReasoning || '(no reviewer reasoning captured)'}

Agent B is the sole anti-tautology gate: it separated impl from tests by
path, reverted only the impl (tests must fail), restored (tests must
pass), verified each \`## Acceptance\` bullet is pinned, independently
checked SOLID, scrutinized any test removals, and verified the diff
implements the design doc's Locked decisions.

## Verification

One atomic commit (tests + impl together). CI re-runs the full suite;
Agent B's revert check already proved the tests are load-bearing.

## What if this is wrong?

Close the PR. The bot's feedback loop will read the close reason from
your comment and add a skip-list entry so it doesn't re-attempt the
same cut shape.

<!-- feature-bot: issue=${issueNumber} run=${process.env.GITHUB_RUN_ID ?? 'local'} -->`
  try {
    execFileSync(
      'gh',
      [
        'pr',
        'create',
        '--draft',
        '--title',
        `feat: cut #${issueNumber} — ${issueTitle}`,
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
 * Post the structured NEEDS_INPUT question as a sub-issue comment + apply
 * `needs-info` label. The body is Agent A's verbatim block (question +
 * options + recommendation). Maintainer's answer (any non-bot reply OR
 * removing `needs-info`) re-enters the queue.
 */
async function postInputQuestion(
  octokit: ReturnType<typeof octokitFromEnv>,
  repo: RepoIdentity,
  issueNumber: number,
  body: string,
): Promise<void> {
  const runId = process.env.GITHUB_RUN_ID ?? 'local'
  const commentBody = `> *This was generated by AI during triage.*

⚠ **Feature-bot needs your input to proceed.**

Agent A reached a design decision that the cut spec + design doc don't
answer. Choosing one path without your input would either contradict the
design doc OR commit the project to a path you might reject.

${body}

**To resolve:**

1. Read the question + Agent A's recommendation
2. Reply with your answer (or just remove the \`needs-info\` label if
   Agent A's recommendation is correct)
3. The next cron picks up this cut with your input in context

If Agent A asks the same question twice without resolution, I'll escalate
to \`ready-for-human\` (per the MAX_INPUT_REQUESTS=2 cap).

<!-- feature-bot: needs-input issue=${issueNumber} run=${runId} -->`

  try {
    await octokit.issues.createComment({ ...repo, issue_number: issueNumber, body: commentBody })
  } catch (err) {
    printWarning(`Could not post NEEDS_INPUT comment on #${issueNumber}: ${err}`)
  }
}

async function postBodyErrorComment(
  octokit: ReturnType<typeof octokitFromEnv>,
  repo: RepoIdentity,
  issueNumber: number,
  errors: readonly { kind: string; section?: string }[],
): Promise<void> {
  const sections = errors
    .filter(e => e.kind === 'missing-required-section')
    .map(e => e.section)
    .filter(Boolean)
    .map(s => `\`## ${s![0].toUpperCase() + s!.slice(1)}\``)
    .join(', ')
  const hasMissingFeature = errors.some(e => e.kind === 'missing-feature')
  const lines = [
    '> *This was generated by AI during triage.*',
    '',
    '⚠ **Cut sub-issue body is missing required fields.**',
    '',
  ]
  if (hasMissingFeature) {
    lines.push('- Missing `**Feature**: <slug>` field at the top of the body')
  }
  if (sections) {
    lines.push(`- Missing required section(s): ${sections}`)
  }
  lines.push(
    '',
    'Per `design-feature-bot.md` Q2 + Cut 5 refinement, the cut sub-issue body must contain:',
    '',
    '```markdown',
    '**Feature**: <slug>',
    '**Depends on**: #N, #M  (or empty/none)',
    '',
    '## Spec',
    '...narrative...',
    '',
    '## Acceptance',
    '- ...',
    '',
    '## SOLID (when applicable)',
    '...',
    '',
    '## Tests',
    '- bots/.../tests/foo.test.ts',
    '```',
    '',
    'Edit the body to add the missing fields, then remove the `needs-info` label to re-queue.',
    '',
    `<!-- feature-bot: body-error issue=${issueNumber} run=${process.env.GITHUB_RUN_ID ?? 'local'} -->`,
  )
  try {
    await octokit.issues.createComment({ ...repo, issue_number: issueNumber, body: lines.join('\n') })
  } catch (err) {
    printWarning(`Could not post body-error comment on #${issueNumber}: ${err}`)
  }
}

async function postDepInvalidComment(
  octokit: ReturnType<typeof octokitFromEnv>,
  repo: RepoIdentity,
  issueNumber: number,
  depNumber: number,
  reason: 'not-found' | 'not-a-cut',
): Promise<void> {
  const why =
    reason === 'not-found'
      ? `#${depNumber} doesn't exist in this repository.`
      : `#${depNumber} exists but isn't labeled \`enhancement\` — it's not a cut sub-issue.`
  const body = `> *This was generated by AI during triage.*

⚠ **Cut sub-issue references an invalid dependency.**

The \`**Depends on**:\` line cites #${depNumber}, but ${why}

Fix the dependency reference in the body, then remove the \`needs-info\`
label to re-queue.

<!-- feature-bot: dep-invalid issue=${issueNumber} dep=${depNumber} run=${process.env.GITHUB_RUN_ID ?? 'local'} -->`
  try {
    await octokit.issues.createComment({ ...repo, issue_number: issueNumber, body })
  } catch (err) {
    printWarning(`Could not post dep-invalid comment on #${issueNumber}: ${err}`)
  }
}

async function postDepOpenComment(
  octokit: ReturnType<typeof octokitFromEnv>,
  repo: RepoIdentity,
  issueNumber: number,
  openDeps: readonly number[],
): Promise<void> {
  // Skip if we've already posted a wait-for-dep comment on this cut for
  // these same deps — avoid spamming the issue on every cron tick.
  const marker = `feature-bot: dep-waiting issue=${issueNumber}`
  try {
    const { data: comments } = await octokit.issues.listComments({
      ...repo,
      issue_number: issueNumber,
      per_page: 100,
    })
    if (comments.some(c => (c.body ?? '').includes(marker))) {
      printNotice(`#${issueNumber}: dep-waiting comment already posted; staying quiet this cron.`)
      return
    }
  } catch {
    // best-effort
  }
  const depList = openDeps.map(n => `#${n}`).join(', ')
  const body = `> *This was generated by AI during triage.*

ℹ **Waiting for dependencies to close.**

This cut depends on ${depList} which ${openDeps.length === 1 ? 'is' : 'are'} still open. I'll retry on the next cron after ${openDeps.length === 1 ? 'it closes' : 'they close'}.

<!-- feature-bot: dep-waiting issue=${issueNumber} run=${process.env.GITHUB_RUN_ID ?? 'local'} -->`
  try {
    await octokit.issues.createComment({ ...repo, issue_number: issueNumber, body })
  } catch (err) {
    printWarning(`Could not post dep-waiting comment on #${issueNumber}: ${err}`)
  }
}

async function applyLabelBestEffort(
  octokit: ReturnType<typeof octokitFromEnv>,
  repo: RepoIdentity,
  issueNumber: number,
  label: string,
): Promise<void> {
  try {
    await addLabel(octokit, repo, issueNumber, label)
  } catch (err) {
    printWarning(`Could not apply '${label}' to #${issueNumber}: ${err}`)
  }
}

/**
 * Reviewer-loop escalation. Mirrors fix-bot's escalateToHuman shape
 * (rule 38 symmetric audit) — four steps:
 *
 *   1. Append entry to skip-list.json locally
 *   2. Open a draft PR with that skip-list entry (so next run honors it
 *      even after runner-local fs is gone)
 *   3. Post a stuck-comment on the sub-issue explaining why
 *   4. Apply `ready-for-human` + close the sub-issue
 *
 * Without steps 2-4, the only memory of the bot's reviewer loop is the
 * runner-local skip-list.json that vanishes on workflow teardown.
 */
async function escalateToHuman(
  octokit: ReturnType<typeof octokitFromEnv>,
  repo: ReturnType<typeof repoFromEnv>,
  issueNumber: number,
  skipList: SkipList,
  fingerprint: IssueFingerprint,
  opts: { reason: SkipReason; reasonNote: string },
): Promise<void> {
  // Step 1: write skip-list locally
  const entry: SkipListEntry = {
    fingerprint,
    reason: opts.reason,
    reasonNote: opts.reasonNote,
    addedAt: new Date().toISOString(),
    addedBy: 'bot',
  }
  const added = appendEntry(skipList, entry)
  if (added) {
    writeSkipList(SKIP_LIST_ABS, skipList)
    printNotice(`Recorded skip-list entry for #${fingerprint.issueNumber} (${opts.reason})`)
  }

  // Step 2: open draft PR for the skip-list change so it lands on main.
  const dateStr = new Date().toISOString().slice(0, 10)
  const skipBranch = `feature-bot-skip/${dateStr}-cut-${issueNumber}`
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
    execFileSync('git', ['push', '-u', 'origin', skipBranch], { cwd: REPO_ROOT, stdio: 'inherit' })
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

Adds a skip-list entry so feature-bot doesn't re-attempt cut #${issueNumber} on every cron.

**Reason:** \`${opts.reason}\`

**Note from the reviewer loop:**

> ${opts.reasonNote.slice(0, 1500)}

**What to do next:**

Read the comment feature-bot just posted on #${issueNumber}. If the reasoning looks right, either merge this PR (durable skip), close the underlying issue, or open the cut yourself based on the analysis. If the reasoning was wrong, close this PR and reopen #${issueNumber} (or remove the \`ready-for-human\` label) to let feature-bot retry.

<!-- feature-bot: skip-entry issue=${issueNumber} reason=${opts.reason} run=${process.env.GITHUB_RUN_ID ?? 'local'} -->`,
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

  // Step 3 + 4: post stuck-comment + apply ready-for-human + close.
  try {
    const ghServer = process.env.GITHUB_SERVER_URL ?? 'https://github.com'
    const repoSlug = `${repo.owner}/${repo.repo}`
    const runId = process.env.GITHUB_RUN_ID ?? 'local'
    const workflowRunUrl =
      runId === 'local' ? '(local run — no workflow URL)' : `${ghServer}/${repoSlug}/actions/runs/${runId}`

    const body = `> *This was generated by AI during triage.*

⚠ **Feature-bot escalation — needs human attention.**

**Reason:** \`${opts.reason}\`

**Note from the loop:**

> ${opts.reasonNote.slice(0, 2000)}

**Workflow run:** ${workflowRunUrl}

I've stopped attempting this cut and applied \`ready-for-human\` (removing it from my queue). Next steps for the maintainer:

1. **Read the reasoning** above + the workflow run's transcript artifact (\`bots/transcripts/\`) for the full analysis
2. **If the reasoning is right** — close this cut OR implement it manually based on the analysis
3. **If you want me to retry** — remove the \`ready-for-human\` label AND remove (or clear) the skip-list entry (the PR I just opened). Then the next cron picks this cut up again.

<!-- feature-bot: escalation issue=${issueNumber} reason=${opts.reason} run=${runId} -->`

    await octokit.issues.createComment({ ...repo, issue_number: issueNumber, body })
    await addLabel(octokit, repo, issueNumber, 'ready-for-human')
    // Remove ready-for-agent since we've terminally escalated. Cron's
    // exclude filter handles ready-for-human, but clearing ready-for-agent
    // makes the maintainer's intent clearer when they re-queue.
    await removeLabel(octokit, repo, issueNumber, 'ready-for-agent').catch(() => {})
    printNotice(`Posted escalation comment + applied ready-for-human on #${issueNumber}`)
  } catch (err) {
    printWarning(`Could not post escalation comment on #${issueNumber}: ${err}`)
  }
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})

// Re-export the routing types so external consumers (replay tooling, future
// compactor) can read the orchestrator's decision-making vocabulary without
// reaching into private modules. Cargo-cult-free per rule 19 — these are
// already the names tests use.
export type { AttemptOutcome, RouteContext, RouteDecision }
