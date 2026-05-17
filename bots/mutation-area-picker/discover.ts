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
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
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
 * Estimate per-module runtime contribution in minutes.
 * Proxy heuristic: `srcLOC * 0.05` minutes per file. A 200-line
 * file ≈ 10 min of mutation time; a 50-line file ≈ 2.5 min. Real
 * Stryker timings vary by mutant density + test runner overhead;
 * this is a conservative upper bound for budget management. The
 * Future-direction note in the design doc is to read actual
 * per-file timing from Stryker's JSON output.
 */
export function estimateRuntimeMinutes(srcLOC: number): number {
  return srcLOC * 0.05
}
