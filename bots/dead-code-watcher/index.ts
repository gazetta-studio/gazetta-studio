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
import {
  type Finding,
  filterStableFindings,
  type KnipReport,
  parseKnipReport,
  rankFindings,
} from '../_lib/knip-parse.js'
import { fingerprintToBranch, pastPROutcome } from '../_lib/past-pr.js'
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

  // No past PR — fresh investigation. Hand to Claude.
  const branchName = fingerprintToBranch(finding.fingerprint)
  const transcriptPath = resolve(
    TRANSCRIPTS_DIR,
    `${RUN_TIMESTAMP}-dead-code-${branchName.replace(/[/-]/g, '_')}.jsonl`,
  )
  printTranscriptPath(transcriptPath)

  const prompt = `${promptTemplate}

FINDING_JSON=${JSON.stringify(
    {
      fingerprint: finding.fingerprint,
      fingerprintLabel: formatFingerprint(finding.fingerprint),
      file: finding.file,
      symbol: finding.symbol,
      lastModifiedDays: finding.lastModifiedDays,
    },
    null,
    2,
  )}
BRANCH_NAME=${branchName}
SKIP_LIST_PATH=${SKIP_LIST_PATH}
RUN_ID=${process.env.GITHUB_RUN_ID ?? 'local'}`

  const result = await runClaude({
    prompt,
    transcriptPath,
    allowedTools: ['Bash', 'Read', 'Grep', 'Glob', 'Write', 'Edit'],
  })
  if (!result.success) {
    printWarning(`Claude exited ${result.exitCode} on ${formatFingerprint(finding.fingerprint)}`)
  }
  return 'invoked-claude'
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
