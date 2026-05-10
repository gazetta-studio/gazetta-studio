/**
 * mutation-watcher — daily review of Stryker mutation-testing results.
 *
 * Pairs with the existing `Mutation` workflow (`.github/workflows/mutation.yml`)
 * which runs Stryker nightly at 03:00 UTC and uploads an HTML report as the
 * `mutation-report` artifact. This bot runs at 03:30 UTC, fetches that
 * artifact, and hands the report to `claude -p` to identify surviving
 * mutants worth filing as bugs.
 *
 * Producer-bot pattern (shared with flake-watcher):
 *   Self-classifies output as `bug` + `area: X` + `ready-for-agent`,
 *   bypassing triage-bot. The mutation report IS the validation that the
 *   surviving mutant represents a real test gap — no further triage adds
 *   value. Goes straight into fix-bot's queue.
 *
 * Per-issue grain: ONE mutated source file = ONE issue. A file with five
 * surviving mutants gets five investigation points in one issue, not five
 * separate issues. Same root-cause-class scoping rule flake-watcher applies
 * to test files.
 *
 * Run locally:
 *   DRY_RUN=1 GITHUB_REPOSITORY=gazetta-studio/gazetta-studio \
 *     GH_TOKEN=$(gh auth token) npm run mutation-watcher -w @gazetta/bots
 * Run in CI:
 *   .github/workflows/mutation-watcher.yml (daily 03:30 UTC)
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runClaude } from '../_lib/claude.js'
import { findWorkflowId, octokitFromEnv, repoFromEnv } from '../_lib/github.js'
import { printBanner, printNotice, printRunSummary, printTranscriptPath, printWarning } from '../_lib/ui.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = resolve(HERE, 'prompt.md')
const REPO_ROOT = resolve(HERE, '../..')

const WORKFLOW_NAME = process.env.WORKFLOW_NAME ?? 'Mutation'
const ARTIFACT_NAME = process.env.ARTIFACT_NAME ?? 'mutation-report'
const DRY_RUN = process.env.DRY_RUN === '1'
const TRANSCRIPTS_DIR = resolve(HERE, '../transcripts')
const REPORT_STAGING_DIR = resolve(HERE, '../mutation-report-staging')
const RUN_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')

async function main(): Promise<void> {
  printBanner({
    name: 'mutation-watcher',
    tagline: 'producer bot · self-classifies',
    purpose: 'Review Stryker mutation report; file issues for surviving mutants.',
    inputs: [
      `Latest successful ${WORKFLOW_NAME} workflow run's mutation-report artifact`,
      'Open issues for the affected source files (for dedup)',
    ],
    outputs: [
      'New issue per source file with surviving mutants — `bug` + `area: X` + `ready-for-agent`',
      'Or comment on existing matching issue (source-run-deduped)',
    ],
  })

  const repo = repoFromEnv()
  const octokit = octokitFromEnv()
  const workflowId = await findWorkflowId(octokit, repo, WORKFLOW_NAME)

  printNotice(`Looking up latest successful ${WORKFLOW_NAME} run (workflow id ${workflowId})`)

  // Find the most recent SUCCESSFUL Mutation run. Stryker exits non-zero
  // when its threshold breaks; we want a run that completed cleanly so the
  // artifact is well-formed. Failures here mean Stryker itself crashed —
  // not actionable for mutation analysis.
  const { data: runs } = await octokit.actions.listWorkflowRuns({
    ...repo,
    workflow_id: workflowId,
    status: 'success',
    per_page: 1,
  })
  const sourceRun = runs.workflow_runs[0]
  if (!sourceRun) {
    printNotice(`No successful ${WORKFLOW_NAME} runs found. Nothing to analyze.`)
    return
  }

  printNotice(
    `Source run: id=${sourceRun.id} · sha ${sourceRun.head_sha.slice(0, 8)} · created ${sourceRun.created_at}`,
  )

  // Stage the report on disk so Claude can grep / parse it via Bash.
  // Re-fetching every run is fine — artifacts are small (Stryker HTML is
  // a single ~3 MB file) and the cron is daily.
  if (existsSync(REPORT_STAGING_DIR)) {
    rmSync(REPORT_STAGING_DIR, { recursive: true, force: true })
  }
  mkdirSync(REPORT_STAGING_DIR, { recursive: true })

  printNotice(`Downloading ${ARTIFACT_NAME} from run ${sourceRun.id}...`)
  const dl = spawnSync('gh', ['run', 'download', String(sourceRun.id), '-n', ARTIFACT_NAME, '-D', REPORT_STAGING_DIR], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  })
  if (dl.status !== 0) {
    printWarning(`Failed to download ${ARTIFACT_NAME} from run ${sourceRun.id}.`)
    printWarning('Is the artifact still available (30-day retention)?')
    process.exit(1)
  }

  // Locate the HTML report. Stryker writes to packages/gazetta/reports/mutation/
  // by default; the workflow uploads that whole directory. After download,
  // the file is at REPORT_STAGING_DIR/mutation.html (or sometimes
  // REPORT_STAGING_DIR/<sub>/mutation.html depending on artifact shape).
  const htmlPath = findReportHtml(REPORT_STAGING_DIR)
  if (!htmlPath) {
    console.error(`No mutation.html found under ${REPORT_STAGING_DIR}. Listing:`)
    for (const entry of readdirSync(REPORT_STAGING_DIR, { recursive: true, withFileTypes: true })) {
      const path = entry.parentPath ? resolve(entry.parentPath, entry.name) : entry.name
      console.error(`  ${path}`)
    }
    process.exit(1)
  }
  printNotice(`Mutation report: ${htmlPath}`)

  if (DRY_RUN) {
    printNotice(`DRY_RUN=1 — exiting before invoking Claude.`)
    return
  }

  const promptTemplate = readFileSync(PROMPT_PATH, 'utf-8')
  mkdirSync(TRANSCRIPTS_DIR, { recursive: true })
  const transcriptPath = resolve(TRANSCRIPTS_DIR, `${RUN_TIMESTAMP}-mutation-run-${sourceRun.id}.jsonl`)
  printTranscriptPath(transcriptPath)

  // The prompt receives:
  //   - SOURCE_RUN_ID: the Mutation workflow run whose artifact we're analyzing
  //     (used in outcome tags and issue bodies for traceability)
  //   - SOURCE_RUN_SHA: the commit Stryker ran against
  //   - REPORT_HTML: absolute path to the HTML file (Claude greps + parses it)
  //   - RUN_ID: this watcher's own GitHub Actions run ID (for the outcome tag's
  //     "which watcher run found this" provenance)
  const prompt = `${promptTemplate}

SOURCE_RUN_ID=${sourceRun.id}
SOURCE_RUN_SHA=${sourceRun.head_sha}
SOURCE_RUN_CREATED_AT=${sourceRun.created_at}
REPORT_HTML=${htmlPath}
RUN_ID=${process.env.GITHUB_RUN_ID ?? 'local'}`

  const runStart = Date.now()
  try {
    const result = await runClaude({
      prompt,
      transcriptPath,
      // Bash for gh + grep/jq, Read for inspecting report + source files
      // Claude wants to cite, Grep/Glob for finding test files that should
      // have caught a surviving mutant.
      allowedTools: ['Bash', 'Read', 'Grep', 'Glob'],
    })
    if (!result.success) {
      printWarning(`mutation-watcher exited ${result.exitCode}; transcript at ${transcriptPath}`)
    }
  } catch (err) {
    printWarning(`mutation-watcher threw: ${err}; transcript at ${transcriptPath}`)
  }

  const totalSec = Math.round((Date.now() - runStart) / 1000)
  printRunSummary({
    verb: 'Analyzed',
    processed: 1,
    total: 1,
    skipped: 0,
    notes: [`Source run: ${sourceRun.id}`, `Transcript: ${transcriptPath}`],
    elapsedSec: totalSec,
  })
}

/**
 * Walk the staging dir looking for `mutation.html`. Stryker's HTML reporter
 * always writes that filename; the artifact contents may or may not include
 * a wrapping subdirectory depending on how the workflow uploaded it.
 */
function findReportHtml(root: string): string | null {
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name === 'mutation.html') {
      const parent = entry.parentPath ?? root
      return resolve(parent, entry.name)
    }
  }
  return null
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
