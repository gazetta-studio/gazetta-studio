/**
 * Stryker mutation-report HTML parser + summarizer.
 *
 * Stryker's HTML reporter embeds the full report as a JS object literal
 * (NOT pure JSON) at line ~334 of mutation.html, in a `<script>` block:
 *
 *   app.report = { "files": { "<path>": { "language": ..., "mutants": [...] } } };
 *
 * The non-JSON-ness comes from Stryker's HTML escape pass: it wraps angle-
 * brackets inside string values with literal `"+"` concatenation tokens
 * (e.g. `"...Set<"+"foo"`). `JSON.parse` chokes on those; `vm.runInNewContext`
 * evaluates them as JS string concatenation and produces the right object.
 *
 * Why parse-in-TS instead of parse-in-prompt:
 *   - The full report is ~3 MB. Reading it into Claude's context wastes
 *     ~50% of the available window before any analysis happens.
 *   - Per the failed run 25637089951, Claude's autocompact thrashed when
 *     it tried to enrich the analysis with source-file reads on top of
 *     the in-context report.
 *   - The parsing is a deterministic transformation (file shape →
 *     summary). Doing it in TS produces a fixture-testable, type-checked
 *     module instead of a prompt instruction Claude has to re-derive
 *     every run.
 *
 * Architecture parallel: triage-bot's orchestrator filters open issues
 * via the GitHub API into a ranked candidate list, then hands one
 * candidate at a time to Claude. mutation-watcher does the same with
 * mutants instead of issues — orchestrator filters down to actionable
 * surviving mutants per-file, hands a small summary to Claude, Claude
 * writes the issue bodies.
 */
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

/**
 * Stryker mutant statuses we care about.
 *
 *   Survived       — test ran but didn't catch the change. Real test gap.
 *   NoCoverage     — no test executed the code at all. Worse — tests don't
 *                    reach this path.
 *   Killed         — working as intended. Skip.
 *   Timeout        — Stryker infra issue. Skip.
 *   RuntimeError   — likely test setup problem. Skip.
 *   CompileError   — TS rejected the mutant. Stryker artifact, not a real
 *                    gap (the mutant wouldn't compile in production
 *                    either). Skip.
 *   Pending        — incomplete mutation testing run. Skip.
 *
 * Only Survived + NoCoverage feed into actionable issues.
 */
type ActionableStatus = 'Survived' | 'NoCoverage'
const ACTIONABLE_STATUSES: ReadonlySet<ActionableStatus> = new Set(['Survived', 'NoCoverage'])

interface StrykerMutant {
  id: string
  mutatorName: string
  replacement: string
  status: string
  location: { start: { line: number; column: number }; end: { line: number; column: number } }
  statusReason?: string
  /** Original source between location.start and location.end. May be absent when Stryker emits compile-error mutants. */
  originalText?: string
}

interface StrykerFile {
  language: string
  mutants: StrykerMutant[]
}

interface StrykerReport {
  schemaVersion?: string
  files: Record<string, StrykerFile>
  thresholds?: { high: number; low: number }
  projectRoot?: string
}

/**
 * One actionable mutant, projected from Stryker's shape into the slim
 * shape Claude will see in the prompt.
 */
export interface ActionableMutant {
  mutator: string
  status: ActionableStatus
  /** Line range in the source file. */
  startLine: number
  endLine: number
  /** Mutator's replacement text, truncated. */
  replacement: string
}

/**
 * One source file's summary: which mutants survived, plus the per-file
 * killed/total counts that drive the kill-ratio threshold.
 */
export interface FileSummary {
  /** Source path relative to the package being mutated, e.g. `src/admin-api/routes/publish.ts`. */
  path: string
  totalMutants: number
  killedCount: number
  survivedCount: number
  noCoverageCount: number
  /** killedCount / (killedCount + survivedCount + noCoverageCount). 1.0 = perfect coverage. */
  killRatio: number
  /** Up to MAX_MUTANTS_PER_FILE actionable mutants. */
  mutants: ActionableMutant[]
}

export interface MutationSummary {
  /** Total number of files Stryker mutated. */
  totalFiles: number
  /** Files with at least one actionable mutant, sorted by descending impact (gap count, then descending kill-ratio inverse). */
  files: FileSummary[]
  /** Files filtered out by the high-kill-ratio rule (≥KILL_RATIO_THRESHOLD AND ≤MAX_TRIVIAL_GAPS). */
  skippedHighScoreFiles: number
  /** Total surviving mutants across the report (for context). */
  totalSurvived: number
  /** Total no-coverage mutants across the report (for context). */
  totalNoCoverage: number
}

/** Cap mutants per file so a 50-mutant file doesn't dominate one issue. */
const MAX_MUTANTS_PER_FILE = 8

/** Cap on replacement text per mutant — Claude doesn't need the full mutated source. */
const MAX_REPLACEMENT_LEN = 80

/**
 * Files with kill-ratio above this threshold AND fewer than
 * MAX_TRIVIAL_GAPS surviving+no-coverage mutants are skipped. The
 * threshold expresses "this file is mostly tested; the surviving
 * mutants are likely marginal or boundary-case noise rather than
 * actionable coverage gaps."
 */
const KILL_RATIO_THRESHOLD = 0.85
const MAX_TRIVIAL_GAPS = 4

/**
 * Read mutation.html, extract `app.report = { ... }`, evaluate as JS,
 * and return the parsed report.
 *
 * Throws if the HTML doesn't contain the assignment or evaluation fails.
 */
export function parseStrykerReport(htmlPath: string): StrykerReport {
  const html = readFileSync(htmlPath, 'utf-8')

  // Stryker's HTML reporter emits `app.report = {...};` on a single
  // line. The assignment is followed by the rest of the inline script
  // (theme handling, etc.), so we anchor on `app.report = ` and walk to
  // the end of the line; the trailing `;` is then the assignment
  // terminator. (We don't try to match braces — the value contains
  // arbitrarily-nested braces inside string values that confound naive
  // regex matching.)
  const lineMatch = html.match(/app\.report\s*=\s*(\{.*\});\s*$/m)
  if (!lineMatch) {
    throw new Error(`Stryker report at ${htmlPath} does not contain a recognizable app.report assignment.`)
  }

  // Evaluate as JavaScript — handles the literal `"+"` concatenation
  // tokens Stryker embeds inside string values (a quirk of its HTML
  // escape pass on TS compile-error messages).
  const jsExpression = lineMatch[1]
  let report: unknown
  try {
    report = runInNewContext(`(${jsExpression})`, {}, { timeout: 5000, displayErrors: true })
  } catch (err) {
    throw new Error(`Failed to evaluate Stryker app.report expression: ${(err as Error).message}`)
  }

  if (!isStrykerReport(report)) {
    throw new Error(`Stryker app.report did not match expected shape (missing 'files' record).`)
  }
  return report
}

function isStrykerReport(value: unknown): value is StrykerReport {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.files === 'object' && v.files !== null
}

/**
 * Project a parsed Stryker report into a slim, prioritized summary
 * suitable for the prompt. Steps:
 *
 *   1. For each file, count Killed / Survived / NoCoverage / other.
 *   2. Skip files with killRatio ≥ KILL_RATIO_THRESHOLD AND
 *      ≤ MAX_TRIVIAL_GAPS gaps (mostly-tested-with-marginal-residual).
 *   3. For remaining files, project each Survived/NoCoverage mutant
 *      into ActionableMutant shape; cap at MAX_MUTANTS_PER_FILE per
 *      file.
 *   4. Sort files by gap count desc, then by killRatio asc (worse
 *      coverage first).
 */
export function summarizeReport(report: StrykerReport): MutationSummary {
  const files: FileSummary[] = []
  let skippedHighScoreFiles = 0
  let totalSurvived = 0
  let totalNoCoverage = 0

  for (const [path, fileData] of Object.entries(report.files)) {
    let killedCount = 0
    let survivedCount = 0
    let noCoverageCount = 0
    const actionable: ActionableMutant[] = []

    for (const mutant of fileData.mutants) {
      if (mutant.status === 'Killed') {
        killedCount++
      } else if (mutant.status === 'Survived') {
        survivedCount++
      } else if (mutant.status === 'NoCoverage') {
        noCoverageCount++
      }
      // Other statuses (Timeout, RuntimeError, CompileError, Pending) are
      // counted in totalMutants but don't affect killRatio numerator/
      // denominator — they're Stryker-side issues, not coverage signal.

      if (ACTIONABLE_STATUSES.has(mutant.status as ActionableStatus)) {
        actionable.push({
          mutator: mutant.mutatorName,
          status: mutant.status as ActionableStatus,
          startLine: mutant.location.start.line,
          endLine: mutant.location.end.line,
          replacement: truncate(mutant.replacement, MAX_REPLACEMENT_LEN),
        })
      }
    }

    totalSurvived += survivedCount
    totalNoCoverage += noCoverageCount

    const gapCount = survivedCount + noCoverageCount
    if (gapCount === 0) continue // file fully covered, nothing to file

    const totalCounted = killedCount + gapCount
    const killRatio = totalCounted === 0 ? 0 : killedCount / totalCounted

    // Skip mostly-tested files with marginal residual.
    if (killRatio >= KILL_RATIO_THRESHOLD && gapCount <= MAX_TRIVIAL_GAPS) {
      skippedHighScoreFiles++
      continue
    }

    // Sort actionable mutants by line number (stable, makes reading the
    // issue body easier) and cap.
    actionable.sort((a, b) => a.startLine - b.startLine)
    const cappedMutants = actionable.slice(0, MAX_MUTANTS_PER_FILE)

    files.push({
      path,
      totalMutants: fileData.mutants.length,
      killedCount,
      survivedCount,
      noCoverageCount,
      killRatio,
      mutants: cappedMutants,
    })
  }

  // Sort files by impact: most gaps first, ties broken by lowest kill-ratio.
  files.sort((a, b) => {
    const gapDiff = b.survivedCount + b.noCoverageCount - (a.survivedCount + a.noCoverageCount)
    if (gapDiff !== 0) return gapDiff
    return a.killRatio - b.killRatio
  })

  return {
    totalFiles: Object.keys(report.files).length,
    files,
    skippedHighScoreFiles,
    totalSurvived,
    totalNoCoverage,
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max - 1)}…`
}

/**
 * Map a source path to an `area: <X>` label per the producer-bot
 * convention. Mirrors the path → area table in mutation-watcher's
 * prompt.md.
 *
 * Returning the area in TS (rather than asking Claude to derive it
 * from the path) is one less judgment call per issue Claude has to
 * make under tight context.
 */
export function pathToArea(path: string): string {
  if (path.startsWith('src/history')) return 'area: renderer'
  if (path.startsWith('src/publish')) return 'area: renderer'
  if (path.startsWith('src/admin-api/')) return 'area: cms'
  if (path.startsWith('src/alt/')) return 'area: cms'
  // Fallback for any future addition — the prompt instructs Claude to
  // narrate this case via a Decision: line.
  return 'area: renderer'
}
