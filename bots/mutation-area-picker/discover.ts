/**
 * Discover candidate modules for the mutation-area-picker.
 *
 * Walks `packages/gazetta/src/**\/*.ts` and returns paths NOT
 * already in the current mutate glob and NOT skip-listed.
 *
 * Module granularity is per-file (not per-glob). Today's
 * stryker.config.json mixes both — `src/admin-api/**\/*.ts` covers
 * many files; the bot normalises by expanding globs to file paths
 * for comparison.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { isReExportBarrel } from './barrel-detector.js'
import { isPureTypesFile, isSparseMutationSurface } from './pure-types-detector.js'
import { findSkipMatch, type SkipList } from './skip-list.js'

export interface CandidateOpts {
  /** Absolute path to repo root. */
  repoRoot: string
  /** Source root to walk (default `packages/gazetta/src`). */
  srcRoot?: string
  /** Currently-scoped glob entries from stryker.config.json. */
  currentMutateGlob: string[]
  /** Skip-list to honour. */
  skipList: SkipList
}

/**
 * Return repo-relative module paths eligible as ADD candidates.
 * Excludes: `.test.ts`, files already in mutate glob, files matching
 * skip-list entries or rules.
 */
export function discoverCandidates(opts: CandidateOpts): string[] {
  const srcRoot = opts.srcRoot ?? 'packages/gazetta/src'
  const allTsFiles = walkTsFiles(opts.repoRoot, srcRoot)
  const scopedFiles = new Set(expandGlob(opts.currentMutateGlob, allTsFiles))

  return allTsFiles.filter(path => {
    if (path.endsWith('.test.ts') || path.endsWith('.test.tsx')) return false
    if (path.endsWith('.d.ts')) return false
    if (scopedFiles.has(path)) return false
    if (findSkipMatch(opts.skipList, { path }) !== null) return false
    // Read once; skip content-based filters on read failure so a
    // transient IO error doesn't silently exclude a real module.
    let source: string
    try {
      source = readFileSync(join(opts.repoRoot, path), 'utf-8')
    } catch {
      return true
    }
    // Pure re-export barrels have no behavioral surface to mutate;
    // proposing them wastes a pick and is rejected by the config guard
    // at PR-review time. See barrel-detector.ts for the reason.
    if (isReExportBarrel(source)) return false
    // Pure-type files (only `export type` / `export interface`, no
    // runtime values) produce zero mutants and silently register as
    // vacuously 100% killed — burning a glob slot for no signal.
    // See pure-types-detector.ts (issue #706).
    if (isPureTypesFile(source)) return false
    // Near-pure-types files (e.g. 150 lines of `export type` /
    // `export interface` + 1 trivial function) satisfy the ≥1
    // pure-types gate but yield only a handful of mutants. Churn from
    // unrelated edits inflates their inclusion score; the size + count
    // gate demotes them before scoring while leaving small utility
    // files (few lines, few declarations) as normal candidates. See
    // pure-types-detector.ts + issue #723.
    if (isSparseMutationSurface(source)) return false
    return true
  })
}

/**
 * Walk a directory recursively, returning all `.ts` and `.tsx`
 * files as paths RELATIVE to the repo root.
 */
function walkTsFiles(repoRoot: string, relRoot: string): string[] {
  const absRoot = join(repoRoot, relRoot)
  const results: string[] = []
  function recurse(absDir: string): void {
    let entries: string[]
    try {
      entries = readdirSync(absDir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.stryker-tmp' || entry.startsWith('.')) continue
      const abs = join(absDir, entry)
      let stat
      try {
        stat = statSync(abs)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        recurse(abs)
      } else if ((entry.endsWith('.ts') || entry.endsWith('.tsx')) && !entry.endsWith('.d.ts')) {
        results.push(relative(repoRoot, abs).split('\\').join('/'))
      }
    }
  }
  recurse(absRoot)
  return results
}

/**
 * Expand `mutate` glob entries to concrete file paths from the
 * walked set. Supports:
 *   - exact paths (treated literally)
 *   - simple star patterns (`foo/*.ts`, `foo/**\/*.ts`)
 * Glob entries are RELATIVE TO THE STRYKER CONFIG'S WORKING DIR
 * (`packages/gazetta/`), so we prefix them with that path.
 */
export function expandGlob(globEntries: string[], allFiles: string[]): string[] {
  const expanded: string[] = []
  for (const entry of globEntries) {
    // Stryker globs are relative to packages/gazetta/
    const fullPattern = entry.startsWith('packages/') ? entry : `packages/gazetta/${entry}`
    if (!fullPattern.includes('*')) {
      // Exact path
      expanded.push(fullPattern)
      continue
    }
    // Convert simple glob to regex
    const regex = new RegExp(
      `^${fullPattern
        .replace(/[.+?^$()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '§§DS§§')
        .replace(/\*/g, '[^/]*')
        .replace(/§§DS§§/g, '.*')}$`,
    )
    for (const path of allFiles) {
      if (regex.test(path)) expanded.push(path)
    }
  }
  return expanded
}

/**
 * Estimate per-module runtime in minutes. The factor argument is
 * minutes-per-line, calibrated by the caller from the current
 * scoped set's known runtime: `KNOWN_RUNTIME_MIN / SUM(LOC scoped)`.
 *
 * The first run on 2026-05-17 used a hardcoded `0.05` and produced
 * 393 min estimate against a 105 min actual budget — ~3.75× too
 * high. Self-calibration grounds the estimate in real data instead
 * of guessing. Future direction is to read Stryker's per-file
 * timing report directly; this is the simpler interim.
 *
 * Default factor when no calibration data exists: `0.013` —
 * empirically derived from the first run (105 / 7870 LOC across
 * the 8-entry mutate glob, expanded to 47 files). Used during
 * bootstrap weeks before the bot has its own data; replaced by
 * self-calibration once any scoped LOC sum is observed.
 */
export function estimateRuntimeMinutes(srcLOC: number, minutesPerLine = 0.013): number {
  return srcLOC * minutesPerLine
}

/**
 * Compute the calibration factor from the current scoped set's
 * total LOC and a known total runtime. Returns minutes-per-line.
 *
 * If the total LOC is 0 (degenerate; empty mutate glob), returns
 * the conservative default 0.013 so subsequent calls don't divide
 * by zero.
 */
export function computeRuntimeCalibration(totalScopedLOC: number, knownRuntimeMin: number): number {
  if (totalScopedLOC === 0) return 0.013
  return knownRuntimeMin / totalScopedLOC
}
