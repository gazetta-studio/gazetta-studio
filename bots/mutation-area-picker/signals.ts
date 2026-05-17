/**
 * Signal collectors for mutation-area-picker.
 *
 * Five inclusion signals (for un-mutated modules) + two eviction
 * signals (for scoped modules). Each is a pure function over its
 * inputs; I/O (git log, gh API) is wrapped in injected helpers so
 * tests can substitute fixture data.
 *
 * Per [design-mutation-area-picker.md](../../.claude/rules/design-mutation-area-picker.md)
 * §"Inclusion score" and §"Eviction score".
 */

// ─────────────────────────────────────────────────────────────────────────────
// I/O helpers — injected so tests can mock without touching the filesystem
// or GitHub API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pluggable signal-collection environment. Tests provide fixture
 * implementations; production wires real git/gh/fs calls.
 */
export interface SignalEnv {
  /**
   * Return absolute git commit count touching `modulePath` since
   * `sinceDays` ago. `--name-only` output filtered to the module's path.
   */
  countCommitsTouching(modulePath: string, sinceDays: number): Promise<number>
  /**
   * Same query as `countCommitsTouching` but restricted to commits
   * with `Co-Authored-By: Claude` in their message. Indicator of
   * AI-pairing density.
   */
  countAIPairedCommitsTouching(modulePath: string, sinceDays: number): Promise<number>
  /**
   * Line counts: src file LOC and corresponding tests' LOC.
   * For a module at `packages/gazetta/src/foo/bar.ts`, tests are
   * found via `packages/gazetta/tests/**\/*bar*`.
   */
  countLines(absolutePath: string): Promise<number>
  /**
   * Return paths of test files matching the module by basename
   * heuristic. Caller passes the basename without extension; helper
   * scans the test dir.
   */
  findRelatedTestFiles(moduleBasename: string): Promise<string[]>
  /**
   * Return open issues with the given label whose title or body
   * mentions `modulePath` or its basename.
   */
  findFlakeIssuesMentioning(modulePath: string): Promise<number>
  /**
   * Return count of merged `fix:` PRs in the last `sinceDays` whose
   * file list includes `modulePath`.
   */
  countRecentFixPRsTouching(modulePath: string, sinceDays: number): Promise<number>
  /**
   * Return mutation-watcher issue statistics for `modulePath`:
   * total issues filed in the last `sinceDays`, and how many of
   * those are now closed-merged.
   */
  countMutationIssues(modulePath: string, sinceDays: number): Promise<{ total: number; closedMerged: number }>
}

// ─────────────────────────────────────────────────────────────────────────────
// Inclusion signals — for un-mutated modules
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Raw signal samples for one module. Composer normalises across
 * the candidate set before weighting.
 */
export interface InclusionSignals {
  /** Co-Authored-By: Claude commits in last 90d touching the module. */
  aiPairingDensity: number
  /** Inverse test/source LOC ratio — higher = less coverage. */
  testCoverageRatioInverse: number
  /** Commits touching the module in last 90d. */
  recentChurn: number
  /** Count of open flake-watcher issues whose body mentions the module. */
  flakeCorrelation: number
  /** Count of merged `fix:` PRs touching the module in last 30d. */
  bugFixCorrelation: number
}

export interface InclusionConfig {
  /** Window for AI-pairing + churn queries. Default 90 days. */
  windowDays: number
  /** Window for bug-fix PR query. Default 30 days. */
  bugFixWindowDays: number
}

export const DEFAULT_INCLUSION_CONFIG: InclusionConfig = {
  windowDays: 90,
  bugFixWindowDays: 30,
}

/**
 * Collect raw inclusion signals for one module path. Pure function
 * over the environment; tests substitute fixture envs.
 */
export async function collectInclusionSignals(
  env: SignalEnv,
  modulePath: string,
  srcAbsPath: string,
  config: InclusionConfig = DEFAULT_INCLUSION_CONFIG,
): Promise<InclusionSignals> {
  const [aiPairingDensity, recentChurn, flakeCorrelation, bugFixCorrelation, srcLOC] = await Promise.all([
    env.countAIPairedCommitsTouching(modulePath, config.windowDays),
    env.countCommitsTouching(modulePath, config.windowDays),
    env.findFlakeIssuesMentioning(modulePath),
    env.countRecentFixPRsTouching(modulePath, config.bugFixWindowDays),
    env.countLines(srcAbsPath),
  ])

  // For test/source ratio: find test files by basename heuristic
  const basename = pathToBasename(modulePath)
  const testFiles = await env.findRelatedTestFiles(basename)
  const testLOCs = await Promise.all(testFiles.map(f => env.countLines(f)))
  const testLOC = testLOCs.reduce((a, b) => a + b, 0)

  // Inverse coverage ratio: ratio = testLOC / srcLOC; inverse = 1 / (1 + ratio)
  // — clamps to [0, 1]; thin coverage (low ratio) → high inverse → high score
  const ratio = srcLOC === 0 ? 0 : testLOC / srcLOC
  const testCoverageRatioInverse = 1 / (1 + ratio)

  return {
    aiPairingDensity,
    testCoverageRatioInverse,
    recentChurn,
    flakeCorrelation,
    bugFixCorrelation,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Eviction signals — for scoped modules
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Raw eviction signals. The composer checks both conditions:
 * kill-ratio sustained AND fix-rate high. Either alone is
 * insufficient (see ADR-0014).
 */
export interface EvictionSignals {
  /** Kill ratios from the last N weekly Stryker runs, oldest-first. */
  killRatioHistory: number[]
  /** Total mutation-watcher issues filed for this module in lookback window. */
  mutationIssuesTotal: number
  /** Of those, how many are closed-merged. */
  mutationIssuesClosedMerged: number
}

export interface EvictionConfig {
  /** Window for mutation-watcher issue stats. Default 90 days. */
  issueWindowDays: number
  /** How many weeks of kill-ratio history to consider. Default 4. */
  killRatioWeeks: number
}

export const DEFAULT_EVICTION_CONFIG: EvictionConfig = {
  issueWindowDays: 90,
  killRatioWeeks: 4,
}

/**
 * Collect eviction signals for one scoped module. The kill-ratio
 * history is passed in pre-fetched (the bot already loads the
 * Stryker timing report once per run; per-module slicing happens
 * upstream).
 */
export async function collectEvictionSignals(
  env: SignalEnv,
  modulePath: string,
  killRatioHistory: number[],
  config: EvictionConfig = DEFAULT_EVICTION_CONFIG,
): Promise<EvictionSignals> {
  const stats = await env.countMutationIssues(modulePath, config.issueWindowDays)
  // Take last N weeks; if fewer entries exist (bootstrap), use what we have
  const recentHistory = killRatioHistory.slice(-config.killRatioWeeks)
  return {
    killRatioHistory: recentHistory,
    mutationIssuesTotal: stats.total,
    mutationIssuesClosedMerged: stats.closedMerged,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip directory + extension from a module path.
 * `packages/gazetta/src/archive/index.ts` → `index`
 * `packages/gazetta/src/publish.ts` → `publish`
 */
export function pathToBasename(modulePath: string): string {
  const filename = modulePath.split('/').pop() ?? modulePath
  return filename.replace(/\.[^.]+$/, '')
}
