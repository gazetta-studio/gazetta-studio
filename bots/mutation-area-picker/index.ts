/**
 * mutation-area-picker — weekly autonomous bot that owns the
 * `mutate` glob in `packages/gazetta/stryker.config.json`.
 *
 * Per [design-mutation-area-picker.md](../../.claude/rules/design-mutation-area-picker.md):
 * the bot manages a PORTFOLIO of mutated modules under a runtime
 * budget. Every Sunday after the weekly Stryker run completes, it
 * reads:
 *   - current mutate glob from stryker.config.json
 *   - latest Stryker results (kill ratios per scoped module)
 *   - git log (churn + AI-pairing density per src module)
 *   - GitHub issues (flake correlation) + PRs (bug-fix correlation)
 *   - mutation-watcher's per-file close rates
 * Computes inclusion scores (5 signals) for un-mutated modules and
 * eviction scores for scoped modules. Then applies a decision tree:
 *
 *   ADD     — budget headroom + top candidate above threshold
 *   SWAP    — at budget + top candidate outranks a graduating scoped
 *   REMOVE  — at budget + a scoped graduates but nothing to swap
 *   NOOP    — nothing justified; exit silently
 *
 * Eviction empirical (not time-bound) per ADR-0014: kill ratio > 0.85
 * sustained 4 weeks AND > 70% of recent mutation-watcher issues
 * closed-merged. First 4 weeks of operation are bootstrap (ADD only).
 *
 * No Agent B reviewer loop — mutation testing IS the empirical
 * reviewer (next Stryker run validates the pick). Bot makes one
 * Claude call per ACTING week to compose the PR body from the
 * decision payload; NOOP weeks exit before any Claude call.
 *
 * Memory:
 *   - `skip-list.json` — never-mutate + maintainer-rejected modules
 *   - `reviewer-log.jsonl` — every decision, persisted via
 *     actions/cache@v4 per ADR-0011
 *   - `lessons-learned.md` — cross-run patterns, rewritten monthly
 *
 * Run locally:
 *   DRY_RUN=1 GITHUB_REPOSITORY=gazetta-studio/gazetta-studio \
 *     GH_TOKEN=$(gh auth token) npm run mutation-area-picker -w @gazetta/bots
 * Run in CI:
 *   .github/workflows/mutation-area-picker.yml (weekly Sun after Mutation)
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { printBanner, printNotice, printRunSummary, printWarning } from '../_lib/ui.js'
import { decide, type Decision, type ScopedModule, type UnMutatedCandidate } from './decision.js'
import { computeRuntimeCalibration, discoverCandidates, estimateRuntimeMinutes, expandGlob } from './discover.js'
import {
  appendReviewerLog,
  countWeeklyRuns,
  readReviewerLog,
  REVIEWER_LOG_PATH,
  type ReviewerLogEntry,
} from './reviewer-log.js'
import { composeInclusionScores, evaluateEviction } from './scoring.js'
import { collectEvictionSignals, collectInclusionSignals } from './signals.js'
import { createSignalEnv } from './signal-env.js'
import { readSkipList, SKIP_LIST_PATH } from './skip-list.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../..')
const SKIP_LIST_ABS = resolve(REPO_ROOT, SKIP_LIST_PATH)
const REVIEWER_LOG_ABS = resolve(REPO_ROOT, REVIEWER_LOG_PATH)
const LESSONS_PATH = 'bots/mutation-area-picker/lessons-learned.md'
const LESSONS_ABS = resolve(REPO_ROOT, LESSONS_PATH)
const STRYKER_CONFIG_PATH = 'packages/gazetta/stryker.config.json'
const STRYKER_CONFIG_ABS = resolve(REPO_ROOT, STRYKER_CONFIG_PATH)

const DRY_RUN = process.env.DRY_RUN === '1'

/**
 * Per-cron wall-clock budget for the bot itself (not the mutation
 * run it influences). Most of the wall time is gh API calls + git
 * log scans; Claude is one short prompt at the end. 10 min is
 * generous.
 */
const PER_RUN_BUDGET_MS = Number(process.env.BUDGET_MS ?? 10 * 60 * 1000)

/**
 * Bootstrap window: first N weekly runs do ADD-only (no eviction).
 * Need 4 weeks of Stryker history before the eviction rule's
 * "kill ratio sustained across last 4 weekly Stryker runs" can fire.
 */
const BOOTSTRAP_WEEKS = Number(process.env.BOOTSTRAP_WEEKS ?? '4')

/**
 * Total nightly Stryker BUDGET in minutes — the max the bot is willing
 * to let the portfolio grow to. Hard ceiling is 180 (workflow timeout);
 * default 150 leaves 30 min variance margin.
 */
const BUDGET_MINUTES = Number(process.env.MUTATION_BUDGET_MINUTES ?? '150')

/**
 * The bot's anchor for runtime calibration: what the CURRENT nightly
 * actually takes. The calibration factor is CURRENT ÷ scoped LOC; that
 * factor then estimates per-module runtime consistently across scoped
 * and candidate. Default 105 min = the observed 1h 45m nightly today.
 * Operators bump this only when Stryker's true runtime changes
 * meaningfully (different runner, different test suite).
 */
const CURRENT_RUNTIME_MINUTES = Number(process.env.MUTATION_CURRENT_RUNTIME_MINUTES ?? '105')

/** Min inclusion score required to ADD a module. Default 0.4 per design doc. */
const INCLUSION_THRESHOLD = Number(process.env.INCLUSION_THRESHOLD ?? '0.4')

/** Min eviction score required to SWAP/REMOVE. Default 0.7. */
const EVICTION_THRESHOLD = Number(process.env.EVICTION_THRESHOLD ?? '0.7')

async function main(): Promise<void> {
  printBanner({
    name: 'mutation-area-picker',
    tagline: 'strategic portfolio manager',
    purpose: "Own stryker.config.json's mutate glob; ADD / SWAP / REMOVE under runtime budget.",
    inputs: [
      'stryker.config.json (current mutate glob)',
      'latest Stryker results (kill ratios, runtime per file)',
      'git log (churn + AI-pairing density per src module)',
      'GitHub issues (flake correlation) + PRs (bug-fix correlation)',
      'skip-list.json + reviewer-log.jsonl + lessons-learned.md (memory)',
    ],
    outputs: ['Draft PR adding/swapping/removing one module in mutate glob, OR silent NOOP'],
  })

  const runStart = Date.now()

  // Step 1: Load memory.
  const skipList = readSkipList(SKIP_LIST_ABS)
  const reviewerLog = readReviewerLog(REVIEWER_LOG_ABS)
  const lessonsLearned = existsSync(LESSONS_ABS) ? readFileSync(LESSONS_ABS, 'utf-8') : ''
  const weeksRun = countWeeklyRuns(reviewerLog)
  const inBootstrap = weeksRun < BOOTSTRAP_WEEKS

  printNotice(`Skip-list: ${skipList.entries.length} entries + ${skipList.rules.length} rules`)
  printNotice(`Reviewer-log: ${reviewerLog.length} historical entries (${weeksRun} distinct weekly runs)`)
  printNotice(`Lessons file: ${lessonsLearned ? `${lessonsLearned.length} bytes` : 'absent'}`)
  if (inBootstrap) {
    printNotice(`Bootstrap mode: week ${weeksRun + 1}/${BOOTSTRAP_WEEKS} — eviction disabled, ADD only`)
  }

  // Step 2: Read current mutate glob.
  const strykerConfig = readStrykerConfig(STRYKER_CONFIG_ABS)
  const currentGlob = (strykerConfig.mutate ?? []) as string[]
  printNotice(`Current mutate glob: ${currentGlob.length} entries`)

  // Step 3: Discover candidates — every src module not currently mutated + not skip-listed.
  const candidatePaths = discoverCandidates({
    repoRoot: REPO_ROOT,
    currentMutateGlob: currentGlob,
    skipList,
  })
  printNotice(`Candidates (un-mutated, not skip-listed): ${candidatePaths.length}`)

  if (DRY_RUN) {
    printNotice('DRY_RUN=1 — exiting before signal collection or decision.')
    if (candidatePaths.length > 0) {
      printNotice(
        `Sample candidates: ${candidatePaths.slice(0, 5).join(', ')}${candidatePaths.length > 5 ? ', …' : ''}`,
      )
    }
    return
  }

  // Step 4: Collect signals for every candidate + every scoped module.
  const env = createSignalEnv({
    repoRoot: REPO_ROOT,
    ghRepo: process.env.GITHUB_REPOSITORY,
  })

  printNotice(`Collecting inclusion signals for ${candidatePaths.length} candidates…`)
  const inclusionRawSignals = await Promise.all(
    candidatePaths.map(p => collectInclusionSignals(env, p, resolve(REPO_ROOT, p))),
  )

  // Compose scores across the candidate set
  const inclusionScores = composeInclusionScores(inclusionRawSignals)
  // Pre-fetch LOC for both candidates AND scoped (need scoped LOC FIRST for runtime calibration)
  const candidateLOCs = await Promise.all(candidatePaths.map(p => env.countLines(resolve(REPO_ROOT, p))))

  // Step 5: Evaluate scoped modules. Compute the runtime-calibration
  // factor BEFORE estimating any per-module runtime — calibration is
  // anchored to the known nightly Stryker runtime against the current
  // scoped LOC sum, so estimates stay grounded in reality instead of
  // hardcoded LOC×constant guesses (the original 0.05 produced ~4×
  // over-estimates; see first-run log 2026-05-17).
  //
  // Per-bot kill-ratio history is bootstrap-empty; in production this
  // reads from the last N weekly Stryker run artifacts. For now we
  // pass empty history per scoped module — evaluateEviction returns
  // "history too short" which keeps everything in scope. The proper
  // wire-up to gh run download lands as a future-direction item per
  // the design doc.
  const scopedFiles = expandGlob(currentGlob, await listAllSrcTsFiles())
  printNotice(`Scoped modules (expanded from ${currentGlob.length} glob entries): ${scopedFiles.length}`)

  // Compute calibration: KNOWN current nightly runtime / sum of scoped LOC.
  // Anchored to actual observed runtime (CURRENT_RUNTIME_MINUTES), NOT
  // the bot's growth budget. This way the factor stays grounded even
  // as the bot expands the portfolio toward BUDGET.
  const scopedLOCs = await Promise.all(scopedFiles.map(p => env.countLines(resolve(REPO_ROOT, p))))
  const totalScopedLOC = scopedLOCs.reduce((a, b) => a + b, 0)
  const minutesPerLine = computeRuntimeCalibration(totalScopedLOC, CURRENT_RUNTIME_MINUTES)
  printNotice(
    `Runtime calibration: ${totalScopedLOC} scoped LOC ÷ ${CURRENT_RUNTIME_MINUTES} min observed runtime = ${minutesPerLine.toFixed(4)} min/line`,
  )

  // Now build candidates + scoped with the calibrated factor.
  const unMutated: UnMutatedCandidate[] = candidatePaths.map((path, i) => ({
    modulePath: path,
    inclusionScore: inclusionScores[i],
    estimatedRuntimeMinutes: estimateRuntimeMinutes(candidateLOCs[i], minutesPerLine),
  }))

  const scoped: ScopedModule[] = await Promise.all(
    scopedFiles.map(async (path, i) => {
      const evictionSignals = await collectEvictionSignals(env, path, [])
      const evaluation = evaluateEviction(evictionSignals)
      return {
        modulePath: path,
        eviction: evaluation,
        estimatedRuntimeMinutes: estimateRuntimeMinutes(scopedLOCs[i], minutesPerLine),
      }
    }),
  )

  const currentRuntimeMinutes = scoped.reduce((sum, s) => sum + s.estimatedRuntimeMinutes, 0)
  printNotice(`Estimated current portfolio runtime: ${currentRuntimeMinutes.toFixed(1)} min (budget ${BUDGET_MINUTES})`)

  // Step 6: Apply decision tree.
  const decision = decide({
    unMutated,
    scoped,
    currentRuntimeMinutes,
    budgetMinutes: BUDGET_MINUTES,
    inBootstrap,
    inclusionThreshold: INCLUSION_THRESHOLD,
    evictionThreshold: EVICTION_THRESHOLD,
  })

  printNotice(`Decision: ${decision.action.toUpperCase()}`)
  printNotice(decision.reasoning)

  // Step 7: Log decision regardless of action.
  const topScore = unMutated.length > 0 ? Math.max(...unMutated.map(u => u.inclusionScore)) : 0
  const worstEviction = scoped.length > 0 ? Math.max(...scoped.map(s => s.eviction.score)) : 0
  const logEntry: ReviewerLogEntry = {
    ts: new Date().toISOString(),
    runId: process.env.GITHUB_RUN_ID ?? 'local',
    action: decision.action,
    addedModule: decision.action === 'add' ? decision.module : decision.action === 'swap' ? decision.addModule : null,
    removedModule:
      decision.action === 'remove' ? decision.module : decision.action === 'swap' ? decision.removeModule : null,
    topInclusionScore: topScore,
    worstEvictionScore: worstEviction,
    estimatedRuntimeAfterMinutes: computeRuntimeAfter(decision, currentRuntimeMinutes, unMutated, scoped),
    reasoning: decision.reasoning,
    bootstrapWeek: inBootstrap ? weeksRun + 1 : null,
  }
  try {
    appendReviewerLog(REVIEWER_LOG_ABS, logEntry)
  } catch (err) {
    printWarning(`Failed to append reviewer-log (non-fatal): ${err}`)
  }

  // Step 8: If non-NOOP, write the scope change + open PR.
  if (decision.action === 'noop') {
    const totalSec = Math.round((Date.now() - runStart) / 1000)
    printRunSummary({
      verb: 'Decided',
      processed: 1,
      total: 1,
      skipped: 0,
      notes: ['NOOP — no scope change justified this week.'],
      elapsedSec: totalSec,
    })
    return
  }

  applyScopeChange(decision, currentGlob, scopedFiles)
  openScopeChangePR(decision, logEntry)

  const totalSec = Math.round((Date.now() - runStart) / 1000)
  printRunSummary({
    verb: 'Decided',
    processed: 1,
    total: 1,
    skipped: 0,
    notes: [`Action: ${decision.action}`, `Reasoning: ${decision.reasoning.slice(0, 120)}…`],
    elapsedSec: totalSec,
  })
}

/** Estimate post-decision runtime for the reviewer-log entry. */
function computeRuntimeAfter(
  decision: Decision,
  current: number,
  unMutated: UnMutatedCandidate[],
  scoped: ScopedModule[],
): number {
  if (decision.action === 'noop') return current
  if (decision.action === 'add') {
    const added = unMutated.find(c => c.modulePath === decision.module)
    return current + (added?.estimatedRuntimeMinutes ?? 0)
  }
  if (decision.action === 'remove') {
    const removed = scoped.find(s => s.modulePath === decision.module)
    return current - (removed?.estimatedRuntimeMinutes ?? 0)
  }
  // swap
  const added = unMutated.find(c => c.modulePath === decision.addModule)
  const removed = scoped.find(s => s.modulePath === decision.removeModule)
  return current - (removed?.estimatedRuntimeMinutes ?? 0) + (added?.estimatedRuntimeMinutes ?? 0)
}

/**
 * List all src .ts files for glob expansion. Wraps discover.ts's
 * walker since we need the full set, not just candidates.
 */
async function listAllSrcTsFiles(): Promise<string[]> {
  const { readdirSync, statSync } = await import('node:fs')
  const { join, relative } = await import('node:path')
  const srcRoot = join(REPO_ROOT, 'packages/gazetta/src')
  const results: string[] = []
  function recurse(absDir: string): void {
    let entries: string[]
    try {
      entries = readdirSync(absDir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue
      const abs = join(absDir, entry)
      let stat
      try {
        stat = statSync(abs)
      } catch {
        continue
      }
      if (stat.isDirectory()) recurse(abs)
      else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
        results.push(relative(REPO_ROOT, abs).split('\\').join('/'))
      }
    }
  }
  recurse(srcRoot)
  return results
}

/**
 * Apply the decided scope change to stryker.config.json. Mutates
 * the on-disk file directly (the workflow commits + pushes after).
 *
 * Mutate-glob entries are stored relative to packages/gazetta/, so
 * we strip the prefix when writing.
 */
function applyScopeChange(
  decision: Exclude<Decision, { action: 'noop' }>,
  currentGlob: string[],
  _scopedFiles: string[],
): void {
  const path = resolve(REPO_ROOT, 'packages/gazetta/stryker.config.json')
  const raw = readFileSync(path, 'utf-8')
  const parsed = JSON.parse(raw) as { mutate: string[] } & Record<string, unknown>

  const toRelative = (p: string): string => p.replace(/^packages\/gazetta\//, '')

  if (decision.action === 'add') {
    parsed.mutate = [...currentGlob, toRelative(decision.module)]
  } else if (decision.action === 'remove') {
    parsed.mutate = currentGlob.filter(g => g !== toRelative(decision.module))
  } else if (decision.action === 'swap') {
    parsed.mutate = [
      ...currentGlob.filter(g => g !== toRelative(decision.removeModule)),
      toRelative(decision.addModule),
    ]
  }

  // Write with 2-space indent + trailing newline. Biome's formatter
  // single-lines short arrays where JSON.stringify multi-lines them,
  // so the raw stringify output churns against the repo's canonical
  // shape on every run. Pass through Biome to normalise.
  const written = `${JSON.stringify(parsed, null, 2)}\n`
  writeFileSync(path, written)
  try {
    execFileSync('npx', ['biome', 'format', '--write', path], { cwd: REPO_ROOT, stdio: 'inherit' })
  } catch (err) {
    // Non-fatal — file is committed in JSON.stringify shape if format fails.
    // Maintainer can run biome locally before merge if it matters.
    printWarning(`Biome format on stryker.config.json failed (non-fatal): ${err}`)
  }
  printNotice(`Updated stryker.config.json: ${currentGlob.length} → ${parsed.mutate.length} entries`)
}

/**
 * Commit + push the scope change to a fresh branch + open a draft PR.
 * Best-effort; failures are non-fatal (the change stays in the local
 * working tree for manual recovery).
 */
function openScopeChangePR(decision: Exclude<Decision, { action: 'noop' }>, logEntry: ReviewerLogEntry): void {
  const dateStr = new Date().toISOString().slice(0, 10)
  const branchName = `mutation-scope/${dateStr}-${decision.action}`
  const title =
    decision.action === 'add'
      ? `chore(mutation): add ${decision.module} to stryker mutate glob`
      : decision.action === 'remove'
        ? `chore(mutation): remove ${decision.module} from stryker mutate glob`
        : `chore(mutation): swap ${decision.removeModule} for ${decision.addModule}`

  const body = `## Decision: ${decision.action.toUpperCase()}

${decision.reasoning}

## Memory snapshot at decision time

- Top inclusion score (un-mutated): ${logEntry.topInclusionScore.toFixed(3)}
- Worst eviction score (scoped, closest to graduation): ${logEntry.worstEvictionScore.toFixed(3)}
- Estimated portfolio runtime after this change: ${logEntry.estimatedRuntimeAfterMinutes.toFixed(1)} min (budget ${BUDGET_MINUTES})
- Bootstrap week: ${logEntry.bootstrapWeek ?? 'post-bootstrap (full decision tree active)'}

## What this PR does

${
  decision.action === 'add'
    ? `Adds \`${decision.module}\` to the \`mutate\` glob in \`packages/gazetta/stryker.config.json\`. Next nightly Stryker run will include this module's mutants in the report; mutation-watcher will then file issues for any surviving mutants.`
    : decision.action === 'remove'
      ? `Removes \`${decision.module}\` from the \`mutate\` glob. The module has graduated (kill ratio sustained + fix rate met) per ADR-0014. Freed budget makes room for future ADDs.`
      : `Removes \`${decision.removeModule}\` (graduated) and adds \`${decision.addModule}\` (higher inclusion score). Net runtime change keeps the portfolio under budget.`
}

## What if this is wrong?

Close the PR — the bot's next weekly run will re-evaluate. If the same module keeps getting proposed despite rejection, add a maintainer-rejected entry to \`bots/mutation-area-picker/skip-list.json\`.

<!-- mutation-area-picker: action=${decision.action} run=${logEntry.runId} -->`

  try {
    execFileSync('git', ['checkout', '-b', branchName], { cwd: REPO_ROOT, stdio: 'inherit' })
    execFileSync('git', ['add', 'packages/gazetta/stryker.config.json'], { cwd: REPO_ROOT, stdio: 'inherit' })
    execFileSync('git', ['commit', '-m', title], { cwd: REPO_ROOT, stdio: 'inherit' })
    execFileSync('git', ['push', '-u', 'origin', branchName], { cwd: REPO_ROOT, stdio: 'inherit' })
    execFileSync('gh', ['pr', 'create', '--draft', '--title', title, '--body', body], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    })
  } catch (err) {
    printWarning(`Failed to open scope-change PR: ${err}`)
  }
}

/**
 * Read stryker.config.json. The file is JSON-with-comments-via-_comment-keys
 * (Stryker's convention), so plain JSON.parse works.
 */
function readStrykerConfig(absolutePath: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(absolutePath, 'utf-8'))
  } catch (err) {
    throw new Error(`Failed to read ${absolutePath}: ${err}`)
  }
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
