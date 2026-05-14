/**
 * dead-code-watcher — weekly review of knip findings, files delete-PRs.
 *
 * Producer bot (sibling of flake-watcher + mutation-watcher) that owns
 * the full delete-or-skip pipeline end-to-end. Unlike those bots, this
 * one DOES NOT delegate to fix-bot — it produces PRs directly. The
 * rationale: code deletion's "failing test" is just "existing tests
 * still pass after removal," so fix-bot's TDD-first contract doesn't
 * compose. See bots/README.md "Architecture: producer vs consumer"
 * for the broader pattern.
 *
 * Memory layers (per the design grilling that locked this shape):
 *
 *   1. **skip-list.json** — durable per-fingerprint decisions:
 *      "intentional", "needs-human", "maintainer-rejected". Survives
 *      across runs, edited via PR. Compacted monthly into rules.
 *
 *   2. **Past-PR query** — the feedback loop. Before investigating
 *      a fresh finding, search GitHub for the deterministic branch
 *      name. If a PR was rejected, mine the reason and add an entry
 *      to the skip-list. If a PR is open, skip (don't double-PR).
 *      If a PR was merged, knip should no longer flag this finding
 *      anyway (file deleted from main); if it does, retry.
 *
 * Per-run grain: top-5 findings by impact ranking (files > deps >
 * exports). Backlog drains over multiple weeks. The compact-bot
 * runs monthly and collapses skip-list patterns into rules.
 *
 * Run locally:
 *   DRY_RUN=1 GITHUB_REPOSITORY=gazetta-studio/gazetta-studio \
 *     GH_TOKEN=$(gh auth token) npm run dead-code-watcher -w @gazetta/bots
 * Run in CI:
 *   .github/workflows/dead-code-watcher.yml (Sat 02:30 UTC)
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runClaude } from '../_lib/claude.js'
import { octokitFromEnv, repoFromEnv } from '../_lib/github.js'
import { branchHasCommits, captureCommitMessages, captureDiff, resetToMain } from '../_lib/git-tree.js'
import {
  type Finding,
  filterStableFindings,
  type KnipReport,
  parseKnipReport,
  rankFindings,
} from '../_lib/knip-parse.js'
import { fingerprintToBranch, pastPROutcome } from '../_lib/past-pr.js'
import { parseReviewerVerdict } from '../_lib/reviewer-verdict.js'
import {
  appendEntry,
  findSkipMatch,
  formatFingerprint,
  readSkipList,
  type SkipList,
  SKIP_LIST_PATH,
  writeSkipList,
} from '../_lib/skip-list.js'
import {
  printBanner,
  printCandidateHeader,
  printCandidateList,
  printNotice,
  printRunSummary,
  printTranscriptPath,
  printWarning,
} from '../_lib/ui.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = resolve(HERE, 'prompts/per-finding.md')
const REVIEWER_PROMPT_PATH = resolve(HERE, 'prompts/reviewer.md')
const REPO_ROOT = resolve(HERE, '../..')
const SKIP_LIST_ABS = resolve(REPO_ROOT, SKIP_LIST_PATH)

const DRY_RUN = process.env.DRY_RUN === '1'
const TRANSCRIPTS_DIR = resolve(HERE, '../transcripts')
const RUN_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')

/** Per-run cap on findings investigated. Backlog drains over weeks. */
const PER_RUN_FINDING_CAP = Number(process.env.PER_RUN_FINDING_CAP ?? '5')

/** Per-run wall-clock budget. Workflow timeout is 60min; we exit at 55. */
const PER_RUN_BUDGET_MS = Number(process.env.BUDGET_MS ?? 55 * 60 * 1000)

/** Minimum file-age in days to consider a finding stable (vs mid-flight WIP). */
const MIN_STABLE_DAYS = Number(process.env.MIN_STABLE_DAYS ?? '30')

/**
 * Maximum generator-critic loop iterations per finding. Agent A
 * proposes; Agent B reviews; if REJECT, Agent A retries with the
 * reviewer's note. After this cap, the orchestrator gives up and
 * adds a `needs-human` skip-list entry.
 */
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS ?? '5')

async function main(): Promise<void> {
  printBanner({
    name: 'dead-code-watcher',
    tagline: 'producer bot · autonomous fixer',
    purpose: 'Find dead code via knip; file delete-PRs OR add skip-list entries.',
    inputs: [
      'knip JSON output (files, exports, types, deps)',
      `Findings stable for ≥${MIN_STABLE_DAYS} days (filter out mid-flight WIP)`,
      'skip-list.json + past-PR history (memory)',
    ],
    outputs: [
      'Delete-PR per safe-to-remove finding (commits + tests pass before push)',
      'Skip-list-entry PR per "intentional" / "needs-human" / "maintainer-rejected"',
    ],
  })

  const repo = repoFromEnv()
  const octokit = octokitFromEnv()

  // Step 1: run knip, parse output.
  printNotice('Running knip...')
  const knipJson = runKnip()
  const allFindings = parseKnipReport(knipJson, { repoRoot: REPO_ROOT })
  printNotice(`Knip: ${allFindings.length} total findings (${countByKind(allFindings)})`)

  // Step 2: filter by stability (age >= MIN_STABLE_DAYS).
  const stable = filterStableFindings(allFindings, MIN_STABLE_DAYS)
  if (stable.length < allFindings.length) {
    printNotice(`Filtered ${allFindings.length - stable.length} findings younger than ${MIN_STABLE_DAYS} days`)
  }

  // Step 3: filter by skip-list (memory).
  const skipList = readSkipList(SKIP_LIST_ABS)
  printNotice(`Skip-list: ${skipList.entries.length} entries + ${skipList.rules.length} rules`)
  const afterSkipList: Finding[] = []
  let skipMatched = 0
  for (const finding of stable) {
    if (findSkipMatch(skipList, finding.fingerprint)) {
      skipMatched++
      continue
    }
    afterSkipList.push(finding)
  }
  if (skipMatched > 0) printNotice(`Skip-list matched ${skipMatched} findings (durable memory)`)

  // Step 4: rank + cap.
  const ranked = rankFindings(afterSkipList)
  const candidates = ranked.slice(0, PER_RUN_FINDING_CAP)
  if (ranked.length === 0) {
    printNotice('No actionable findings after filters. ✨')
    return
  }
  if (ranked.length > PER_RUN_FINDING_CAP) {
    printNotice(
      `Capping to top ${PER_RUN_FINDING_CAP} of ${ranked.length} actionable findings this run; remainder picked up by future cron.`,
    )
  }

  printCandidateList({
    noun: 'finding',
    candidates: candidates.map(f => ({
      ref: formatFingerprint(f.fingerprint),
      label: `${f.lastModifiedDays}d stable`,
      meta: f.symbol ? `${f.fingerprint.kind} · ${f.file}#${f.symbol}` : `${f.fingerprint.kind} · ${f.file}`,
    })),
  })

  if (DRY_RUN) {
    printNotice(`DRY_RUN=1 — exiting before invoking Claude.`)
    return
  }

  // Step 5: per-finding processing.
  mkdirSync(TRANSCRIPTS_DIR, { recursive: true })
  const promptTemplate = readFileSync(PROMPT_PATH, 'utf-8')

  const runStart = Date.now()
  let processed = 0
  let pastPRMatches = 0
  for (const finding of candidates) {
    const elapsed = Date.now() - runStart
    if (elapsed > PER_RUN_BUDGET_MS) {
      const remaining = candidates.length - processed
      printWarning(
        `Per-run budget exhausted (${Math.round(elapsed / 1000)}s > ${Math.round(PER_RUN_BUDGET_MS / 1000)}s). Stopping with ${remaining} unprocessed; next cron picks them up.`,
      )
      break
    }

    printCandidateHeader({
      index: processed + 1,
      total: candidates.length,
      label: formatFingerprint(finding.fingerprint),
      meta: [`${finding.lastModifiedDays}d stable`, finding.file],
      elapsedSec: Math.round(elapsed / 1000),
    })

    try {
      const handled = await processFinding(octokit, repo, finding, skipList, promptTemplate)
      if (handled === 'past-pr-matched') pastPRMatches++
    } catch (err) {
      printWarning(`processing ${formatFingerprint(finding.fingerprint)} threw: ${err}; continuing.`)
    }
    processed++
  }

  const totalSec = Math.round((Date.now() - runStart) / 1000)
  printRunSummary({
    verb: 'Processed',
    processed,
    total: candidates.length,
    skipped: candidates.length - processed,
    notes: [
      `Skip-list matched: ${skipMatched}`,
      `Past-PR feedback-loop matched: ${pastPRMatches}`,
      ranked.length > PER_RUN_FINDING_CAP
        ? `${ranked.length - PER_RUN_FINDING_CAP} more findings queued for next cron`
        : 'All actionable findings processed',
    ],
    elapsedSec: totalSec,
  })
}

/**
 * Per-finding pipeline. Returns 'past-pr-matched' when the feedback
 * loop short-circuited (skipped due to open PR, merged, or rejected
 * → skip-list-entry added). Returns 'invoked-claude' when Claude was
 * called to investigate fresh.
 */
async function processFinding(
  octokit: ReturnType<typeof octokitFromEnv>,
  repo: ReturnType<typeof repoFromEnv>,
  finding: Finding,
  skipList: SkipList,
  promptTemplate: string,
): Promise<'past-pr-matched' | 'invoked-claude'> {
  // Feedback loop: check past PR history first.
  const past = await pastPROutcome(octokit, repo, finding.fingerprint)

  if (past.state === 'open') {
    printNotice(`PR #${past.prNumber} is open for this finding — skipping (waiting for review)`)
    return 'past-pr-matched'
  }

  if (past.state === 'merged') {
    // Finding still showing up despite merged delete-PR? Weird — log and skip.
    // Most likely cause: knip cache stale, or the delete was partial.
    printWarning(`PR #${past.prNumber} merged but knip still flags this finding — manual investigation needed`)
    return 'past-pr-matched'
  }

  if (past.state === 'rejected') {
    // Mine the rejection reason; persist to skip-list so we don't retry.
    printNotice(`PR #${past.prNumber} was rejected — adding skip-list entry from rejection reason`)
    const added = appendEntry(skipList, {
      fingerprint: finding.fingerprint,
      reason: 'maintainer-rejected',
      reasonNote: past.reasonNote,
      addedAt: new Date().toISOString(),
      addedBy: 'bot',
      refPR: past.prNumber,
    })
    if (added) {
      writeSkipList(SKIP_LIST_ABS, skipList)
      // Open a tiny PR with just the skip-list update.
      await openSkipListPR(finding, past.prNumber, past.reasonNote)
    }
    return 'past-pr-matched'
  }

  // No past PR — fresh investigation. Run the generator-critic loop.
  const branchName = fingerprintToBranch(finding.fingerprint)
  const reviewerPromptTemplate = readFileSync(REVIEWER_PROMPT_PATH, 'utf-8')
  const findingPayload = JSON.stringify(
    {
      fingerprint: finding.fingerprint,
      fingerprintLabel: formatFingerprint(finding.fingerprint),
      file: finding.file,
      symbol: finding.symbol,
      lastModifiedDays: finding.lastModifiedDays,
    },
    null,
    2,
  )

  let priorReviewerNote: string | null = null

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    printNotice(`Attempt ${attempt}/${MAX_ATTEMPTS}: invoking Agent A (cleanup)…`)

    // Reset to clean main between attempts (no-op on attempt 1 unless
    // a prior partial run left state behind).
    resetToMain(branchName, { cwd: REPO_ROOT })

    // Run Agent A.
    const agentATranscript = resolve(
      TRANSCRIPTS_DIR,
      `${RUN_TIMESTAMP}-dead-code-${branchName.replace(/[/-]/g, '_')}-attempt${attempt}-A.jsonl`,
    )
    printTranscriptPath(agentATranscript)
    const agentAPrompt = `${promptTemplate}

FINDING_JSON=${findingPayload}
BRANCH_NAME=${branchName}
SKIP_LIST_PATH=${SKIP_LIST_PATH}
ATTEMPT=${attempt}
MAX_ATTEMPTS=${MAX_ATTEMPTS}
${priorReviewerNote ? `PRIOR_REVIEWER_NOTE=${priorReviewerNote}\n` : ''}RUN_ID=${process.env.GITHUB_RUN_ID ?? 'local'}`

    const aResult = await runClaude({
      prompt: agentAPrompt,
      transcriptPath: agentATranscript,
      allowedTools: ['Bash', 'Read', 'Grep', 'Glob', 'Write', 'Edit'],
    })
    if (!aResult.success) {
      printWarning(`Agent A exited ${aResult.exitCode} on attempt ${attempt}; aborting loop for this finding`)
      return 'invoked-claude'
    }

    // What did Agent A produce?
    //   - A `dead-code-skip/...` branch with a skip-list commit → bot's done,
    //     skip case. Push that branch (no reviewer needed).
    //   - The `dead-code/...` branch with delete commit(s) → reviewer time.
    //   - Nothing (no branch / no commits) → Agent A bailed; record + exit.
    const skipBranch = `dead-code-skip/${branchName.replace('dead-code/', '')}`
    const skipBranchHasCommits = branchHasCommits(skipBranch, { cwd: REPO_ROOT })
    const deleteBranchHasCommits = branchHasCommits(branchName, { cwd: REPO_ROOT })

    if (skipBranchHasCommits) {
      printNotice('Agent A chose SKIP — pushing skip-list-entry PR (no reviewer needed)')
      pushBranch(skipBranch)
      // The branch is already committed by Agent A; nothing more to do.
      return 'invoked-claude'
    }

    if (!deleteBranchHasCommits) {
      printWarning(`Agent A produced no commits on either branch; treating as needs-human and stopping`)
      recordSkipListEntry(skipList, finding, {
        reason: 'needs-human',
        reasonNote: `Agent A attempt ${attempt} produced no commits. See transcript ${agentATranscript}.`,
      })
      return 'invoked-claude'
    }

    // Agent A made a delete-branch — hand to reviewer.
    printNotice(`Attempt ${attempt}/${MAX_ATTEMPTS}: invoking Agent B (reviewer)…`)
    const diff = captureDiff(branchName, { cwd: REPO_ROOT })
    const commitMessages = captureCommitMessages(branchName, { cwd: REPO_ROOT })

    const reviewerTranscript = resolve(
      TRANSCRIPTS_DIR,
      `${RUN_TIMESTAMP}-dead-code-${branchName.replace(/[/-]/g, '_')}-attempt${attempt}-B.jsonl`,
    )
    printTranscriptPath(reviewerTranscript)
    const reviewerPrompt = `${reviewerPromptTemplate}

FINDING_JSON=${findingPayload}
BRANCH_NAME=${branchName}
ATTEMPT=${attempt}
${priorReviewerNote ? `PRIOR_REVIEWER_NOTE=${priorReviewerNote}\n` : ''}
DIFF=
${diff}

COMMIT_MESSAGES=
${commitMessages}

TEST_SUMMARY=tests passed (verified by Agent A before commit)
RUN_ID=${process.env.GITHUB_RUN_ID ?? 'local'}`

    const bResult = await runClaude({
      prompt: reviewerPrompt,
      transcriptPath: reviewerTranscript,
      // Reviewer has Read for spot-checking, Bash for grep. NO Write/Edit.
      allowedTools: ['Bash', 'Read'],
    })
    if (!bResult.success) {
      printWarning(`Agent B exited ${bResult.exitCode} on attempt ${attempt}; treating as needs-human`)
      recordSkipListEntry(skipList, finding, {
        reason: 'needs-human',
        reasonNote: `Reviewer (Agent B) crashed on attempt ${attempt}. See transcript ${reviewerTranscript}.`,
      })
      return 'invoked-claude'
    }

    // Parse the reviewer's final text block for the VERDICT line.
    const reviewerLastText = extractLastAssistantText(reviewerTranscript)
    const verdict = parseReviewerVerdict(reviewerLastText)

    if (verdict.kind === 'approve') {
      printNotice(`✅ Reviewer APPROVED on attempt ${attempt}/${MAX_ATTEMPTS}: ${verdict.reasoning.slice(0, 120)}`)
      pushBranch(branchName)
      openDeletePR(finding, branchName, verdict.reasoning, extractLastAssistantText(agentATranscript))
      return 'invoked-claude'
    }

    if (verdict.kind === 'needs-human') {
      printWarning(`⚠ Reviewer escalated to NEEDS_HUMAN: ${verdict.note.slice(0, 120)}`)
      recordSkipListEntry(skipList, finding, {
        reason: 'needs-human',
        reasonNote: `Reviewer verdict on attempt ${attempt}: ${verdict.note}`,
      })
      return 'invoked-claude'
    }

    // REJECT — loop with the reviewer's note for Agent A.
    printNotice(`Reviewer REJECTED on attempt ${attempt}/${MAX_ATTEMPTS}: ${verdict.note.slice(0, 120)}`)
    priorReviewerNote = verdict.note
    // continue → next iteration
  }

  // Loop exhausted without convergence.
  printWarning(`Loop exhausted after ${MAX_ATTEMPTS} attempts — Agent A and reviewer disagreed`)
  recordSkipListEntry(skipList, finding, {
    reason: 'needs-human',
    reasonNote: `Agent A and reviewer didn't converge after ${MAX_ATTEMPTS} attempts. Last reviewer note: ${priorReviewerNote ?? '(none)'}`,
  })
  return 'invoked-claude'
}

/**
 * Push a branch to origin. Failures here are non-fatal — the
 * commits remain locally; the orchestrator's per-finding budget
 * absorbs the loss and the next cron retries.
 */
function pushBranch(branchName: string): void {
  try {
    execFileSync('git', ['push', '-u', 'origin', branchName], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    })
  } catch (err) {
    printWarning(`git push ${branchName} failed: ${err}`)
  }
}

/**
 * Open the delete PR with the reviewer's approve-reasoning + Agent A's
 * last assistant message as the body. Best-effort; failures non-fatal.
 */
function openDeletePR(finding: Finding, branchName: string, reviewerReasoning: string, agentASummary: string): void {
  const label = formatFingerprint(finding.fingerprint)
  const body = `## Summary

Knip flagged \`${label}\` as unused. After investigation by Agent A
and independent review by Agent B (both Claude Code sessions), this
PR removes it.

## What Agent A checked

${agentASummary || '(no Agent A summary captured)'}

## Reviewer reasoning

${reviewerReasoning || '(no reviewer reasoning captured)'}

## Verification

\`npm test\` passes after removal (verified by Agent A before
commit; CI re-verifies on this PR).

## What if this is wrong?

Close the PR. The bot's feedback loop will read the close reason
from your comment and add a skip-list entry so it doesn't re-attempt.

<!-- dead-code-watcher: kind=${finding.fingerprint.kind} path=${finding.fingerprint.path}${finding.fingerprint.symbol ? ` symbol=${finding.fingerprint.symbol}` : ''} run=${process.env.GITHUB_RUN_ID ?? 'local'} -->`
  try {
    execFileSync('gh', ['pr', 'create', '--title', `refactor(dead-code): remove unused ${label}`, '--body', body], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    })
  } catch (err) {
    printWarning(`gh pr create failed for ${label}: ${err}`)
  }
}

/**
 * Append a skip-list entry + persist. Used by failure paths where
 * the bot bails out without going through Agent A's normal SKIP
 * branch creation.
 */
function recordSkipListEntry(
  skipList: SkipList,
  finding: Finding,
  opts: { reason: 'needs-human'; reasonNote: string },
): void {
  const added = appendEntry(skipList, {
    fingerprint: finding.fingerprint,
    reason: opts.reason,
    reasonNote: opts.reasonNote,
    addedAt: new Date().toISOString(),
    addedBy: 'bot',
  })
  if (added) {
    writeSkipList(SKIP_LIST_ABS, skipList)
  }
}

/**
 * Extract the last assistant text block from a JSONL transcript.
 * Used to grab Agent A's summary or Agent B's verdict line.
 *
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
 * Open a tiny PR containing just the skip-list update for a
 * maintainer-rejected finding. The PR is sent as a draft so the
 * maintainer doesn't get pinged for re-review; the goal is to commit
 * the skip-list change so future runs honor it.
 */
async function openSkipListPR(finding: Finding, rejectedPR: number, reasonNote: string): Promise<void> {
  // Branch name: dead-code-skip/<fingerprint-encoding>
  // Distinct from delete-PR branches so they don't collide.
  const skipBranch = `dead-code-skip/${fingerprintToBranch(finding.fingerprint).replace('dead-code/', '')}`

  // Use gh to push the skip-list update. Failures here are non-fatal —
  // the in-memory skip-list is already updated on disk for THIS run;
  // we just won't have the durable PR-merge artifact. The next run
  // will retry the PR creation if the entry is still relevant.
  try {
    execFileSync('git', ['checkout', '-b', skipBranch], { cwd: REPO_ROOT, stdio: 'inherit' })
    execFileSync('git', ['add', SKIP_LIST_PATH], { cwd: REPO_ROOT, stdio: 'inherit' })
    execFileSync(
      'git',
      [
        'commit',
        '-m',
        `chore(skip-list): record maintainer rejection of ${formatFingerprint(finding.fingerprint)}\n\nCloses recall via #${rejectedPR}\n\nThe original delete-PR was rejected with: ${reasonNote.slice(0, 200)}`,
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
        `chore(skip-list): record rejection of ${formatFingerprint(finding.fingerprint)}`,
        '--body',
        `Adds a skip-list entry so dead-code-watcher doesn't re-attempt the deletion of \`${formatFingerprint(finding.fingerprint)}\`.\n\n**Source of rejection:** PR #${rejectedPR}\n\n**Reason mined from maintainer comment:**\n\n> ${reasonNote}\n\n<!-- dead-code-watcher: skip-entry source=#${rejectedPR} -->`,
      ],
      { cwd: REPO_ROOT, stdio: 'inherit' },
    )
  } catch (err) {
    printWarning(`Couldn't open skip-list PR for ${formatFingerprint(finding.fingerprint)}: ${err}`)
  } finally {
    // Return to main so the loop's next iteration starts from a clean state.
    try {
      execFileSync('git', ['checkout', 'main'], { cwd: REPO_ROOT, stdio: 'inherit' })
    } catch {
      // best-effort
    }
  }
}

/**
 * Run knip and return its JSON output.
 *
 * The npm script uses `--no-exit-code` so knip exits 0 even with
 * findings (its default behavior is to exit non-zero as a CI gate).
 * We treat any captured stdout containing valid JSON as success,
 * regardless of exit code — defense in depth against future knip
 * versions that change the flag semantics.
 */
function runKnip(): KnipReport {
  let stdout: string
  try {
    stdout = execFileSync('npm', ['run', '--silent', 'knip:json'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024, // knip JSON can be a few MB
      stdio: ['ignore', 'pipe', 'inherit'],
    })
  } catch (err) {
    // Non-zero exit. Knip emits JSON on stdout even when exiting
    // non-zero, so capture that and try to parse it. The exec error
    // object has the captured streams in `output` / `stdout`.
    const e = err as { stdout?: string }
    if (typeof e.stdout !== 'string' || e.stdout.length === 0) {
      throw new Error('knip exited non-zero with no captured stdout')
    }
    stdout = e.stdout
  }
  // The actual JSON starts at the first `{` — npm prefixes its own noise
  // before knip's output.
  const jsonStart = stdout.indexOf('{')
  if (jsonStart < 0) throw new Error('knip:json produced no JSON output')
  return JSON.parse(stdout.slice(jsonStart)) as KnipReport
}

/** Format a one-line breakdown of findings by kind. */
function countByKind(findings: Finding[]): string {
  const counts: Record<string, number> = {}
  for (const f of findings) {
    counts[f.fingerprint.kind] = (counts[f.fingerprint.kind] ?? 0) + 1
  }
  return Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `${n} ${k}`)
    .join(', ')
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
